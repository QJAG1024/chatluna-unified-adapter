import { Context, Logger, Schema } from 'koishi'
import {
    ClientConfig,
    ClientConfigPool
} from 'koishi-plugin-chatluna/llm-core/platform/config'
import { ModelCapabilities } from 'koishi-plugin-chatluna/llm-core/platform/types'
import { ChatLunaPlugin } from 'koishi-plugin-chatluna/services/chat'
import { createLogger } from 'koishi-plugin-chatluna/utils/logger'
import { clientOf } from './client'
import { PROTOCOLS, UnifiedProtocol } from './protocol'
import { setLogger } from './anthropic/logger'

export let logger: Logger

export const reusable = true
export const name = 'chatluna-unified-adapter'

export const inject = {
    required: ['chatluna']
}

export type { UnifiedProtocol }

export interface ModelOverride {
    modelType?: 'LLM 大语言模型' | 'Embeddings 嵌入模型' | 'Reranker 重排序模型'
    modelCapabilities?: ModelCapabilities[]
    contextSize?: number
    maxOutputTokens?: number
}

export interface MetadataConfig {
    enabled: boolean
    sources: string[]
    refreshOnStart: boolean
    refreshInterval: number
    timeout: number
    fillCapabilities: boolean
}

export interface Config extends ChatLunaPlugin.Config {
    platform: string
    protocol: UnifiedProtocol
    apiKeys: [string, string, boolean][]
    authHeader: 'bearer' | 'x-api-key' | 'both'
    headers: [string, string][]
    pullModels: boolean
    modelsURL: string
    modelsProbe: boolean
    blacklistModels: string[]
    modelOverrides: Record<string, ModelOverride>
    metadata: MetadataConfig
    maxContextRatio: number
    temperature: number
    presencePenalty: number
    frequencyPenalty: number
    nonStreaming: boolean
}

/**
 * An instance is one upstream route speaking one wire protocol. Everything the
 * adapter unifies lives in these groups: where the endpoint is and how it
 * authenticates, where its model ids come from, and where each model's context
 * window and capabilities come from. See docs/ARCHITECTURE.md §9.
 *
 * Overridable numbers deliberately carry no default: an absent value means
 * "ask the catalog", which is only expressible while absent stays distinct
 * from a user typing the default in.
 */
const groups = [
    ChatLunaPlugin.Config,
    Schema.object({
        platform: Schema.string().default('unified'),
        protocol: Schema.union(PROTOCOLS).default('chat')
    }),
    Schema.object({
        apiKeys: Schema.array(
            Schema.tuple([
                Schema.string().role('secret').default(''),
                Schema.string().default('https://api.openai.com/v1'),
                Schema.boolean().default(true)
            ])
        )
            .default([[]])
            .role('table'),
        authHeader: Schema.union(['bearer', 'x-api-key', 'both']).default(
            'bearer'
        ),
        headers: Schema.array(
            Schema.tuple([Schema.string(), Schema.string()])
        ).default([])
    }),
    Schema.object({
        pullModels: Schema.boolean().default(true),
        modelsURL: Schema.string().default(''),
        modelsProbe: Schema.boolean().default(true),
        blacklistModels: Schema.array(Schema.string()).default([]),
        modelOverrides: Schema.dict(
            Schema.object({
                modelType: Schema.union([
                    'LLM 大语言模型',
                    'Embeddings 嵌入模型',
                    'Reranker 重排序模型'
                ]),
                modelCapabilities: Schema.array(
                    Schema.union([
                        ModelCapabilities.ToolCall,
                        ModelCapabilities.ImageInput,
                        ModelCapabilities.AudioInput,
                        ModelCapabilities.VideoInput,
                        ModelCapabilities.FileInput,
                        ModelCapabilities.Thinking
                    ])
                ).role('checkbox'),
                contextSize: Schema.number().min(1),
                maxOutputTokens: Schema.number().min(1)
            })
        ).default({})
    }),
    Schema.object({
        metadata: Schema.object({
            enabled: Schema.boolean().default(true),
            sources: Schema.array(Schema.string()).default(['models.dev']),
            refreshOnStart: Schema.boolean().default(true),
            refreshInterval: Schema.number().min(0).default(0),
            timeout: Schema.number().min(1000).default(15_000),
            fillCapabilities: Schema.boolean().default(true)
        })
    }),
    Schema.object({
        maxContextRatio: Schema.number()
            .min(0)
            .max(1)
            .step(0.0001)
            .role('slider')
            .default(0.35),
        temperature: Schema.percent().min(0).max(2).step(0.1).default(1),
        presencePenalty: Schema.number().min(-2).max(2).step(0.1).default(0),
        frequencyPenalty: Schema.number().min(-2).max(2).step(0.1).default(0),
        nonStreaming: Schema.boolean().default(false)
    })
]

export const Config = Schema.intersect(groups as never).i18n({
    'zh-CN': require('./locales/zh-CN.schema.yml'),
    'en-US': require('./locales/en-US.schema.yml')
}) as unknown as Schema<Config>

export function apply(ctx: Context, config: Config) {
    logger = createLogger(ctx, 'chatluna-unified-adapter')
    setLogger(logger)

    ctx.on('ready', async () => {
        const platform = config.platform
        const plugin = new ChatLunaPlugin<ClientConfig, Config>(
            ctx,
            config,
            platform
        )

        plugin.parseConfig(() =>
            config.apiKeys
                .filter(([key, base, enabled]) => {
                    return key.length > 0 && base.length > 0 && enabled
                })
                .map(([key, base]) => {
                    return {
                        apiKey: key,
                        apiEndpoint: base,
                        platform,
                        chatLimit: config.chatTimeLimit,
                        timeout: config.timeout,
                        maxRetries: config.maxRetries,
                        concurrentMaxSize: config.chatConcurrentMaxSize
                    }
                })
        )

        const Client = clientOf(config.protocol)
        const pool = plugin.platformConfigPool as ClientConfigPool<ClientConfig>

        plugin.registerClient(() => new Client(ctx, config, plugin, pool))

        await plugin.initClient()
    })
}
