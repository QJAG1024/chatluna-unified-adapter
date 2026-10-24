import type { Context } from 'koishi'
import {
    ClientConfig,
    ClientConfigPool
} from 'koishi-plugin-chatluna/llm-core/platform/config'
import {
    FileHandlingConfig,
    PlatformModelClient,
    PlatformModelEmbeddingsAndRerankerClient
} from 'koishi-plugin-chatluna/llm-core/platform/client'
import {
    ChatLunaBaseEmbeddings,
    ChatLunaChatModel,
    ChatLunaEmbeddings
} from 'koishi-plugin-chatluna/llm-core/platform/model'
import { ChatLunaReranker } from 'koishi-plugin-chatluna/llm-core/platform/rerank'
import {
    ModelCapabilities,
    ModelInfo,
    ModelType
} from 'koishi-plugin-chatluna/llm-core/platform/types'
import { ChatLunaPlugin } from 'koishi-plugin-chatluna/services/chat'
import { getOpenAIFileHandlingConfig } from '@chatluna/v1-shared-adapter'
import { RunnableConfig } from '@langchain/core/runnables'
import type { Config } from '.'
import { catalog, lookup } from './catalog'
import { listModels } from './discovery'
import { Override, specOf } from './spec'
import { UnifiedRequester } from './requester'
import { buildHeaders, supportsEmbeddings } from './protocol'
import type { ModelUsageReporter } from 'koishi-plugin-chatluna/llm-core/platform/usage'

/**
 * Model assembly for one instance.
 *
 * The whole path is docs/ARCHITECTURE.md §3: manual entries alone when
 * `pullModels` is off, otherwise the endpoint's listing enriched per field, and
 * an empty list — not an error — when neither yields anything.
 */

/** A manual entry, its id's original spelling kept for the model list. */
interface Manual {
    name: string
    override: Override
}

/** Per-client memo of the endpoint's listing. */
export interface ClientState {
    listing?: ReturnType<typeof listModels>
}

/**
 * Build this instance's model list. Never throws: an endpoint with no listing
 * route simply contributes nothing.
 *
 * `state` is per client and holds the listing once fetched, because
 * `BasePlatformClient.getModels()` calls this twice at startup
 * (`isAvailable` -> `init`, then `refreshClient`). It is not shared between
 * instances: each one asks its own endpoint.
 */
export async function refreshModels(
    ctx: Context,
    cfg: Config,
    plugin: ChatLunaPlugin<ClientConfig, Config>,
    requester: UnifiedRequester,
    state: ClientState
): Promise<ModelInfo[]> {
    const manual = manualEntries(cfg)
    const credentials = firstEnabled(cfg)
    const announce = state.listing == null

    let ids: string[] = []

    if (cfg.pullModels && credentials != null) {
        state.listing ??= listModels({
            base: credentials.base,
            modelsURL: cfg.modelsURL,
            probe: cfg.modelsProbe,
            fetch: (url, init) =>
                plugin.fetch(url, {
                    ...init,
                    headers: buildHeaders(
                        cfg.protocol,
                        credentials.key,
                        cfg.authHeader,
                        cfg.headers
                    )
                } as never),
            timeout: cfg.timeout
        })

        const found = await state.listing
        ids = found.ids

        // Report once. `getModels()` runs this twice at startup, and a repeated
        // warning reads like a second, separate failure.
        if (announce) {
            if (found.base != null) {
                ctx.logger('chatluna-unified-adapter').warn(
                    'models listed under %s/models, while requests go to %s',
                    found.base,
                    credentials.base
                )
            }

            if (found.ids.length === 0) {
                // Say which route answered what: "no such route" and "the key
                // was refused" lead to completely different fixes.
                const detail = found.attempts
                    .map((it) => `${it.url} → ${it.status ?? 'network error'}`)
                    .join(', ')
                ctx.logger('chatluna-unified-adapter').warn(
                    'no model list from this endpoint (%s); the adapter loads with %d manually configured model(s)',
                    detail,
                    manual.size
                )
            }
        }
    }

    return assemble(ctx, cfg, manual, ids, requester, plugin)
}

/**
 * Turn ids and manual entries into ModelInfo. Shared by the cached and
 * fresh-discovery paths so both produce the same list.
 */
async function assemble(
    ctx: Context,
    cfg: Config,
    manual: Map<string, Manual>,
    ids: string[],
    requester: UnifiedRequester,
    plugin: ChatLunaPlugin<ClientConfig, Config>
): Promise<ModelInfo[]> {
    // Loading the index is the point; `lookup` reads the module-level result.
    await catalog(ctx, cfg.metadata, (url, init) => plugin.fetch(url, init))

    const fill = cfg.metadata.fillCapabilities
    const seen = new Set<string>()
    const infos: ModelInfo[] = []

    for (const id of ids) {
        const key = id.toLowerCase()
        if (seen.has(key) || blacklisted(cfg, key)) continue

        seen.add(key)
        const spec = specOf(id, manual.get(key)?.override, lookup(id), fill)
        requester.setOutput(spec.info.name, spec.output)
        infos.push(spec.info)
    }

    // Manual entries discovery did not mention are injected, so an endpoint
    // whose listing is empty still serves what the user wrote down. They are
    // deliberately not blacklisted: a manually written id is an explicit ask.
    for (const [key, entry] of manual) {
        if (seen.has(key)) continue

        seen.add(key)
        const spec = specOf(entry.name, entry.override, lookup(key), fill)
        requester.setOutput(spec.info.name, spec.output)
        infos.push(spec.info)
    }

    return infos
}

/** The first key/base pair the user enabled, or undefined when none is usable. */
function firstEnabled(cfg: Config) {
    for (const [key, base, enabled] of cfg.apiKeys) {
        if (enabled && key.length > 0 && base.length > 0) return { key, base }
    }
    return undefined
}

/** Manual entries keyed by lowercased id, original spelling kept aside. */
function manualEntries(cfg: Config) {
    const map = new Map<string, Manual>()

    for (const [key, override] of Object.entries(cfg.modelOverrides ?? {})) {
        const name = key.trim()
        if (name.length === 0 || override == null) continue
        map.set(name.toLowerCase(), { name, override })
    }

    return map
}

function blacklisted(cfg: Config, id: string) {
    return (cfg.blacklistModels ?? []).some((keyword) => {
        const needle = keyword.trim().toLowerCase()
        return needle.length > 0 && id.includes(needle)
    })
}

/** The client for a `chat` instance: models, embeddings and rerankers. */
export class UnifiedEmbeddingsClient extends PlatformModelEmbeddingsAndRerankerClient<ClientConfig> {
    platform: string
    private _requester: UnifiedRequester
    private _plugin: ChatLunaPlugin<ClientConfig, Config>
    private _state: ClientState = {}

    constructor(
        ctx: Context,
        public cfg: Config,
        plugin: ChatLunaPlugin<ClientConfig, Config>,
        pool: ClientConfigPool<ClientConfig>
    ) {
        super(ctx, pool)
        this.platform = cfg.platform
        this._plugin = plugin
        this._requester = new UnifiedRequester(ctx, pool, cfg, plugin)
    }

    async refreshModels(_config?: RunnableConfig) {
        return refreshModels(
            this.ctx,
            this.cfg,
            this._plugin,
            this._requester,
            this._state
        )
    }

    getFileHandlingConfig(): FileHandlingConfig {
        return FILE_HANDLING
    }

    protected _createModel(
        model: string,
        report: ModelUsageReporter
    ): ChatLunaChatModel | ChatLunaBaseEmbeddings | ChatLunaReranker {
        const info = this._modelInfos[model]

        if (info.type === ModelType.embeddings) {
            return new ChatLunaEmbeddings({
                usageReporter: report,
                client: this._requester,
                model,
                maxRetries: this.cfg.maxRetries
            })
        }

        if (info.type === ModelType.reranker) {
            return new ChatLunaReranker({
                usageReporter: report,
                client: this._requester,
                model,
                maxRetries: this.cfg.maxRetries,
                timeout: this.cfg.timeout
            })
        }

        return chatModel(this.cfg, this._requester, info, model, report)
    }
}

/** The client for `responses` and `messages` instances: models only. */
export class UnifiedModelClient extends PlatformModelClient<ClientConfig> {
    platform: string
    private _requester: UnifiedRequester
    private _plugin: ChatLunaPlugin<ClientConfig, Config>
    private _state: ClientState = {}

    constructor(
        ctx: Context,
        public cfg: Config,
        plugin: ChatLunaPlugin<ClientConfig, Config>,
        pool: ClientConfigPool<ClientConfig>
    ) {
        super(ctx, pool)
        this.platform = cfg.platform
        this._plugin = plugin
        this._requester = new UnifiedRequester(ctx, pool, cfg, plugin)
    }

    async refreshModels(_config?: RunnableConfig) {
        return refreshModels(
            this.ctx,
            this.cfg,
            this._plugin,
            this._requester,
            this._state
        )
    }

    getFileHandlingConfig(): FileHandlingConfig {
        return FILE_HANDLING
    }

    protected _createModel(model: string, report: ModelUsageReporter) {
        return chatModel(
            this.cfg,
            this._requester,
            this._modelInfos[model],
            model,
            report
        )
    }
}

/** Pick the client class a protocol needs. */
export function clientOf(protocol: Config['protocol']) {
    return supportsEmbeddings(protocol)
        ? UnifiedEmbeddingsClient
        : UnifiedModelClient
}

/**
 * Inline-data limits. Same set the Claude adapter declares: which model may
 * actually receive an image is gated separately, from its capabilities.
 */
const FILE_HANDLING: FileHandlingConfig = {
    supportedMimeTypes: new Set([
        'text/html',
        'text/css',
        'text/plain',
        'text/markdown',
        'text/xml',
        'text/csv',
        'application/json',
        'application/pdf',
        'image/jpeg',
        'image/png',
        'image/gif',
        'image/webp'
    ]),
    maxTotalSizeBytes: 32 * 1024 * 1024,
    maxFileSizeBytes: 32 * 1024 * 1024,
    maxFileSizeBytesOverrides: {
        'image/jpeg': 5 * 1024 * 1024,
        'image/png': 5 * 1024 * 1024,
        'image/gif': 5 * 1024 * 1024,
        'image/webp': 5 * 1024 * 1024
    }
}

function chatModel(
    cfg: Config,
    requester: UnifiedRequester,
    info: ModelInfo,
    model: string,
    report: ModelUsageReporter
) {
    return new ChatLunaChatModel({
        usageReporter: report,
        requester,
        modelInfo: info,
        model,
        // chatluna reads modelMaxContextSize as the context window; the ratio
        // is what actually caps the prompt.
        modelMaxContextSize: info.maxTokens,
        maxTokenLimit: Math.floor(info.maxTokens * cfg.maxContextRatio),
        temperature: cfg.temperature,
        presencePenalty: cfg.presencePenalty,
        frequencyPenalty: cfg.frequencyPenalty,
        timeout: cfg.timeout,
        maxRetries: cfg.maxRetries,
        llmType: cfg.protocol,
        // Which inline types a model accepts is a per-model question on the
        // OpenAI-shaped wires, and a fixed set on the Messages wire.
        fileHandlingConfig:
            cfg.protocol === 'messages'
                ? FILE_HANDLING
                : (getOpenAIFileHandlingConfig(model) ?? FILE_HANDLING),
        isThinkModel: info.capabilities.includes(ModelCapabilities.Thinking)
    })
}
