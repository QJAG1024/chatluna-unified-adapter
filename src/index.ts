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

/**
 * Shown above the config form in the console.
 *
 * An instance is one upstream route speaking one wire protocol, so the first
 * thing a user needs to know is that several suppliers (or several endpoints of
 * one supplier) mean several instances — and that the platform name is the model
 * prefix they will type.
 */
export const usage = `
## 统一适配器说明

**一个实例 = 一条上游路由 = 一种协议。** 接两个端点就挂两个实例，用不同的
\`platform\` 区分，它同时是模型前缀（如 \`my-gateway/qwen-plus\`）。

### 三步填完

1. **\`platform\`**：给这条路由起个名字，之后模型就以 \`名字/模型名\` 出现。
2. **\`protocol\`**：这条路由讲哪种协议。
   - \`chat\` — OpenAI Chat Completions，绝大多数兼容网关都是这个
   - \`responses\` — OpenAI Responses
   - \`messages\` — Anthropic Messages
3. **\`apiKeys\`**：填 API Key 和请求地址。**地址要带版本路径**，
   如 \`https://api.openai.com/v1\`。

### 模型列表拉不到怎么办

适配器只会从你配的端点要模型列表，拿不到就是空列表——不报错、也不猜。
常见两种原因：

- **这个端点本来就没有 \`/models\`**（不少 Anthropic 兼容端点如此）。
  把 \`modelsURL\` 指向该供应商其他端点的列表地址即可。
- **地址少写了一层**。保持 \`modelsProbe\` 开启，适配器会额外试
  \`地址/v1/models\`，并在日志里告诉你正确地址。

也可以直接关掉 \`pullModels\`，只在 \`modelOverrides\` 里手写要用的模型。

### 模型的上下文与能力从哪来

默认从 [models.dev](https://models.dev) 取上下文长度、输出上限、视觉/工具/
思考能力。拉不到就用 ChatLuna 既有的推断与默认值。

**\`modelOverrides\` 里的设置永远优先**，且只填你写了的字段——没写的仍然走
models.dev。所以新模型发布当天不必等适配器更新，写一条覆写就能用上。

### 已知情况

- 端点若把 embedding、图像生成、语音等**非对话模型**也列出来，它们会被当作
  对话模型登记（无法从名字可靠判断类型）。用 \`blacklistModels\` 过滤，或在
  \`modelOverrides\` 里显式标注类型。
- 工具执行失败时，结果里的错误信息在文本中（退出码、stderr），而非结构化的
  失败标记——与 ChatLuna 官方适配器一致。
`

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
