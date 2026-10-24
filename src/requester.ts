import type { Context } from 'koishi'
import { ChatGeneration, ChatGenerationChunk } from '@langchain/core/outputs'
import {
    EmbeddingsRequester,
    EmbeddingsRequestParams,
    EmbeddingsResult,
    ModelRequester,
    ModelRequestParams,
    RerankerRequester,
    RerankerRequestParams,
    RerankerResult,
    RerankerUsageResult
} from 'koishi-plugin-chatluna/llm-core/platform/api'
import {
    ClientConfig,
    ClientConfigPool
} from 'koishi-plugin-chatluna/llm-core/platform/config'
import { ChatLunaPlugin } from 'koishi-plugin-chatluna/services/chat'
import {
    completion,
    completionStream,
    createEmbeddings,
    createRequestContext,
    createRerank,
    responseApiCompletion,
    responseApiCompletionStream
} from '@chatluna/v1-shared-adapter'
import type { Config } from '.'
import { completionPath, defaultHeaders } from './protocol'
import { AnthropicRequester } from './anthropic/requester'
import { trimUrl } from './endpoints'

/**
 * The requester for a `chat` or `responses` instance.
 *
 * Both wires are implemented by `@chatluna/v1-shared-adapter`; this class only
 * supplies what the shared helpers leave open — where the request goes, what
 * headers it carries, and which of the two wire shapes is in use.
 */
export class UnifiedRequester
    extends ModelRequester
    implements EmbeddingsRequester, RerankerRequester
{
    private _anthropic: AnthropicRequester | undefined

    constructor(
        ctx: Context,
        configPool: ClientConfigPool<ClientConfig>,
        public cfg: Config,
        plugin: ChatLunaPlugin<ClientConfig, Config>
    ) {
        super(ctx, configPool, cfg, plugin)

        if (cfg.protocol === 'messages') {
            this._anthropic = new AnthropicRequester(
                ctx,
                configPool,
                cfg,
                plugin
            )
        }
    }

    get protocol() {
        return this.cfg.protocol
    }

    /**
     * The output ceiling this model was assigned when it was assembled. The
     * Messages wire needs one; the OpenAI-shaped wires do not.
     */
    setOutput(model: string, tokens: number | undefined) {
        this._anthropic?.setOutputTokens(model, tokens)
    }

    async completion(params: ModelRequestParams): Promise<ChatGeneration> {
        if (this._anthropic != null) {
            return this._anthropic.completion(params)
        }

        // `nonStreaming` asks for a real non-streaming HTTP request; the
        // default path aggregates the stream, which is what chatluna expects.
        if (!this.cfg.nonStreaming) return super.completion(params)

        return this.cfg.protocol === 'responses'
            ? responseApiCompletion(this._context(), params)
            : completion(this._context(), params)
    }

    async *completionStream(
        params: ModelRequestParams
    ): AsyncGenerator<ChatGenerationChunk> {
        if (this._anthropic != null) {
            yield* this._anthropic.completionStream(params)
            return
        }

        if (this.cfg.protocol === 'responses') {
            yield* responseApiCompletionStream(this._context(), params)
            return
        }

        yield* completionStream(this._context(), params)
    }

    /**
     * `ModelRequester` declares this abstract, but each protocol here is served
     * by a shared helper that owns its own stream loop, so the overrides above
     * are what actually run. Keeping it unreachable documents that.
     */
    // eslint-disable-next-line require-yield
    protected async *completionStreamInternal(): AsyncGenerator<ChatGenerationChunk> {
        throw new Error('served by completionStream')
    }

    async embeddings(
        params: EmbeddingsRequestParams
    ): Promise<EmbeddingsResult> {
        return createEmbeddings(this._context(), params)
    }

    async rerank(
        params: RerankerRequestParams
    ): Promise<RerankerResult[] | RerankerUsageResult> {
        return createRerank(this._context(), params)
    }

    /**
     * The shared helpers pass their own relative paths, so the base ends up as
     * whatever the config says plus that path. Point them at the protocol's
     * real route instead: an absolute URL survives `concatUrl` untouched, and
     * absolute bases are also how `modelsURL` stays independent of the base.
     */
    concatUrl(url: string) {
        if (/^https?:\/\//.test(url)) return url

        const base = trimUrl(this._config.value.apiEndpoint)
        if (base.length === 0) return url

        switch (url) {
            case 'chat/completions':
            case 'embeddings':
            case 'rerank':
            case 'responses':
            case 'messages':
                return `${base}/${url}`
            case 'models':
                return `${base}/models`
            default:
                return `${base}/${url}`
        }
    }

    /**
     * `shared-adapter`'s non-streaming path drops `stream` but leaves
     * `stream_options` behind, and some upstreams reject that combination
     * outright ("'stream' and 'stream_options' must be set together"). Strip it
     * whenever the request is not streaming, whatever built the body.
     */
    public post(
        url: string,
        data: Parameters<ModelRequester['post']>[1],
        params?: Parameters<ModelRequester['post']>[2]
    ) {
        if (data != null && data.stream !== true) delete data.stream_options
        return super.post(url, data, params)
    }

    buildHeaders(): Record<string, string> {
        const cfg = this.cfg
        const key = this._config.value.apiKey
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://github.com/ChatLunaLab/chatluna',
            'X-Title': 'ChatLuna',
            ...defaultHeaders(cfg.protocol)
        }

        if (cfg.authHeader === 'bearer' || cfg.authHeader === 'both') {
            headers.Authorization = `Bearer ${key}`
        }
        if (cfg.authHeader === 'x-api-key' || cfg.authHeader === 'both') {
            headers['x-api-key'] = key
        }

        for (const [name, value] of cfg.headers) {
            if (name.length > 0) headers[name] = value
        }

        return headers
    }

    private _context() {
        return createRequestContext(
            this.ctx,
            this._config.value,
            this.cfg,
            this._plugin,
            this
        )
    }

    get logger() {
        return this.ctx.logger('chatluna-unified-adapter')
    }
}

export { completionPath }
