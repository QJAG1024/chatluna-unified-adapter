/*
 * Vendored from koishi-plugin-chatluna-claude-adapter@1.4.0-alpha.11
 *   packages/adapter-claude/src/requester.ts (367 lines)
 *   upstream commit: ca1177d4 (ChatLunaLab/chatluna, v1-dev)
 *   vendored: 2026-10-24
 *
 * License: AGPL-3.0, same as this package. Original copyright ChatLunaLab.
 * Re-vendor steps: see src/anthropic/README.md.
 *
 * Local deviations from upstream (keep in sync when re-vendoring):
 *   - Config/logger come from the local plugin entry and ./logger, not `.`
 *   - completionStreamInternal is fed by the per-instance `outputTokens`
 *     (catalog `limit.output` / user override) instead of the constant 10_000
 *   - thinking is decided from the resolved model id's metadata, not from a
 *     `-thinking` name suffix; the suffix stripping and setModels() are gone
 *   - listModels() stays available but discovery no longer calls it
 *   - buildHeaders() honours config.authHeader and config.headers
 */
import { AIMessageChunk } from '@langchain/core/messages'
import { ChatGeneration, ChatGenerationChunk } from '@langchain/core/outputs'
import type { Context } from 'koishi'
import {
    ClientConfig,
    ClientConfigPool
} from 'koishi-plugin-chatluna/llm-core/platform/config'
import {
    ModelRequester,
    ModelRequestParams
} from 'koishi-plugin-chatluna/llm-core/platform/api'
import { ChatLunaPlugin } from 'koishi-plugin-chatluna/services/chat'
import { sseIterable } from 'koishi-plugin-chatluna/utils/sse'
import {
    ChatLunaError,
    ChatLunaErrorCode
} from 'koishi-plugin-chatluna/utils/error'
import { deepAssign } from 'koishi-plugin-chatluna/utils/object'
import {
    createUsageMetadata,
    ReasoningState
} from '@chatluna/v1-shared-adapter'
import type { Config } from '..'
import { DEFAULT_MAX_OUTPUT_TOKENS, defaultHeaders } from '../protocol'
import { logger } from './logger'
import {
    ClaudeDeltaResponse,
    ClaudeListModelsResponse,
    ClaudeReasoningBlockParam,
    ClaudeRequest,
    ClaudeResponseMessage
} from './types'
import {
    convertDeltaToMessageChunk,
    formatToolsToClaudeTools,
    langchainMessageToClaudeMessage
} from './messages'

export class AnthropicRequester extends ModelRequester<ClientConfig, Config> {
    /**
     * Output ceilings by model id, resolved from the catalog and the user's
     * overrides at model-load time. The Messages API requires max_tokens, so a
     * model with no known ceiling still needs a value — that is the caller's
     * `params.maxTokens`, else the protocol default in `outputOf`.
     */
    private _outputs = new Map<string, number>()

    constructor(
        ctx: Context,
        configPool: ClientConfigPool<ClientConfig>,
        public cfg: Config,
        plugin: ChatLunaPlugin<ClientConfig, Config>
    ) {
        super(ctx, configPool, cfg, plugin)
    }

    setOutputTokens(model: string, tokens: number | undefined) {
        if (tokens != null) this._outputs.set(model, tokens)
    }

    /**
     * A real non-streaming request. Upstream had no equivalent — its config had
     * no `nonStreaming` knob — so this is new code rather than vendored.
     */
    async completion(params: ModelRequestParams): Promise<ChatGeneration> {
        const request = deepAssign(
            {},
            {
                model: params.model,
                max_tokens: this._maxTokens(params),
                temperature: params.temperature,
                top_p: params.topP,
                stop_sequences:
                    typeof params.stop === 'string'
                        ? [params.stop]
                        : params.stop,
                stream: false,
                messages: await langchainMessageToClaudeMessage(
                    params.input,
                    this._plugin,
                    params.model
                ),
                tools:
                    params.tools != null
                        ? formatToolsToClaudeTools(params.tools)
                        : undefined
            } satisfies ClaudeRequest,
            params.overrideRequestParams ?? {}
        ) as ClaudeRequest
        request.stream = false

        const response = await this.post('messages', request, {
            signal: params.signal
        })

        if (!response.ok) {
            const detail = await response.text()
            throw new ChatLunaError(
                ChatLunaErrorCode.API_REQUEST_FAILED,
                new Error(
                    `Messages request failed: ${response.status} ${detail}`
                )
            )
        }

        const body = (await response.json()) as ClaudeResponseMessage
        const message = responseToChunk(body)
        const usage = body.usage

        if (usage != null) {
            message.usage_metadata = createUsageMetadata({
                inputTokens: usage.input_tokens,
                outputTokens: usage.output_tokens,
                totalTokens: usage.input_tokens + usage.output_tokens,
                cacheReadTokens: usage.cache_read_input_tokens,
                cacheCreationTokens: usage.cache_creation_input_tokens
            })
        }

        return {
            message,
            text: typeof message.content === 'string' ? message.content : ''
        }
    }

    async *completionStreamInternal(
        params: ModelRequestParams
    ): AsyncGenerator<ChatGenerationChunk> {
        const request = deepAssign(
            {},
            {
                model: params.model,
                max_tokens: this._maxTokens(params),
                temperature: params.temperature,
                top_p: params.topP,
                stop_sequences:
                    typeof params.stop === 'string'
                        ? [params.stop]
                        : params.stop,
                stream: true,
                messages: await langchainMessageToClaudeMessage(
                    params.input,
                    this._plugin,
                    params.model
                ),
                tools:
                    params.tools != null
                        ? formatToolsToClaudeTools(params.tools)
                        : undefined
            } satisfies ClaudeRequest,
            params.overrideRequestParams ?? {}
        ) as ClaudeRequest
        request.stream = true

        const betas = new Set<string>()
        const rawBetas = request.anthropicBeta ?? request['anthropic-beta']

        if (typeof rawBetas === 'string') {
            for (const beta of rawBetas.split(',')) {
                const trimmed = beta.trim()
                if (trimmed.length > 0) betas.add(trimmed)
            }
        } else if (Array.isArray(rawBetas)) {
            for (const beta of rawBetas) {
                const trimmed = beta.trim()
                if (trimmed.length > 0) betas.add(trimmed)
            }
        }

        delete request.anthropicBeta
        delete request['anthropic-beta']

        const response = await this.post('messages', request, {
            signal: params.signal,
            headers:
                betas.size > 0
                    ? { 'anthropic-beta': Array.from(betas).join(',') }
                    : undefined
        })

        const iterator = sseIterable(response, params)
        const reasoningState = new ReasoningState<ClaudeReasoningBlockParam>()

        for await (const event of iterator) {
            if (event.event === 'ping') continue

            if (event.event === 'error') {
                throw new ChatLunaError(
                    ChatLunaErrorCode.API_REQUEST_FAILED,
                    new Error(event.data)
                )
            }

            const chunk = event.data

            if (chunk === '[DONE]') break
            if (chunk === '' || chunk == null || chunk === 'undefined') continue

            const parsedRawChunk = JSON.parse(chunk) as ClaudeDeltaResponse
            const usage =
                parsedRawChunk.type === 'message_start'
                    ? parsedRawChunk.message.usage
                    : parsedRawChunk.type === 'message_delta'
                      ? parsedRawChunk.usage
                      : undefined

            if (usage != null) {
                yield new ChatGenerationChunk({
                    message: new AIMessageChunk({
                        content: '',
                        usage_metadata: createUsageMetadata({
                            inputTokens: usage.input_tokens,
                            outputTokens: usage.output_tokens,
                            totalTokens:
                                usage.input_tokens + usage.output_tokens,
                            cacheReadTokens: usage.cache_read_input_tokens,
                            cacheCreationTokens:
                                usage.cache_creation_input_tokens
                        })
                    }),
                    text: ''
                })
            }

            if (
                parsedRawChunk.type === 'message_delta' ||
                parsedRawChunk.type === 'message_stop' ||
                parsedRawChunk.type === 'content_block_stop'
            ) {
                continue
            }

            if (parsedRawChunk.type === 'content_block_start') {
                const block = parsedRawChunk.content_block
                if (block.type === 'thinking') {
                    reasoningState.append(block.thinking ?? '')
                    reasoningState.blocks[parsedRawChunk.index] = {
                        type: 'thinking',
                        thinking: block.thinking ?? '',
                        signature: block.signature ?? ''
                    }
                    continue
                }

                if (block.type === 'redacted_thinking') {
                    reasoningState.blocks[parsedRawChunk.index] = {
                        type: 'redacted_thinking',
                        data: block.data ?? ''
                    }
                    continue
                }
            }

            if (parsedRawChunk.type === 'content_block_delta') {
                const delta = parsedRawChunk.delta
                if (delta.type === 'thinking_delta') {
                    reasoningState.append(delta.thinking)

                    const block = reasoningState.blocks[parsedRawChunk.index]
                    if (block?.type === 'thinking') {
                        block.thinking += delta.thinking
                    }
                    continue
                }

                if (delta.type === 'signature_delta') {
                    const block = reasoningState.blocks[parsedRawChunk.index]
                    if (block?.type === 'thinking') {
                        block.signature = delta.signature
                    }
                    continue
                }
            }

            const parsedChunk = convertDeltaToMessageChunk(parsedRawChunk)
            if (parsedChunk == null) continue

            const hasMessageChunk =
                (typeof parsedChunk.content === 'string'
                    ? parsedChunk.content.length > 0
                    : Array.isArray(parsedChunk.content) &&
                      parsedChunk.content.length > 0) ||
                (parsedChunk instanceof AIMessageChunk &&
                    (parsedChunk.tool_call_chunks?.length ?? 0) > 0)

            if (hasMessageChunk) reasoningState.end()
            if (!hasMessageChunk) continue

            yield new ChatGenerationChunk({
                message: parsedChunk,
                text: parsedChunk.content as string
            })
        }

        const reasoningBlocks = reasoningState.blocks.filter(
            (block): block is ClaudeReasoningBlockParam =>
                block != null &&
                (block.type === 'redacted_thinking' ||
                    block.signature.length > 0)
        )

        if (reasoningState.content.length > 0 || reasoningBlocks.length > 0) {
            const signature =
                reasoningBlocks.length === 1 &&
                reasoningBlocks[0].type === 'thinking'
                    ? reasoningBlocks[0].signature
                    : undefined

            yield new ChatGenerationChunk({
                message: new AIMessageChunk({
                    content: '',
                    additional_kwargs: {
                        reasoning_content: reasoningState.content,
                        ...(signature != null
                            ? { reasoning_signature: signature }
                            : {}),
                        ...(reasoningBlocks.length > 0
                            ? { reasoning_blocks: reasoningBlocks }
                            : {}),
                        ...(reasoningState.time != null
                            ? { reasoning_time: reasoningState.time }
                            : {})
                    }
                }),
                text: ''
            })

            logger.debug(reasoningState.format, ...reasoningState.params)
        }
    }

    async listModels(options?: {
        afterId?: string
        beforeId?: string
        limit?: number
        anthropicBeta?: string[]
    }): Promise<ClaudeListModelsResponse> {
        const query = new URLSearchParams()

        if (options?.afterId) query.set('after_id', options.afterId)
        if (options?.beforeId) query.set('before_id', options.beforeId)
        if (typeof options?.limit === 'number') {
            query.set('limit', String(options.limit))
        }

        const url = query.size > 0 ? `models?${query.toString()}` : 'models'
        const headers =
            Array.isArray(options?.anthropicBeta) &&
            options.anthropicBeta.length > 0
                ? { 'anthropic-beta': options.anthropicBeta.join(',') }
                : undefined

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let raw: any
        try {
            const response = await this.get(url, headers)

            raw = await response.text()
            if (response.status !== 200) {
                throw new Error(
                    `Error when listing models, Status: ${response.status} ${response.statusText}, Response: ${raw}`
                )
            }

            return JSON.parse(raw) as ClaudeListModelsResponse
        } catch (e) {
            const error = new Error(
                'Error when listing models, Response: ' + JSON.stringify(raw)
            )
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ;(error as any).stack = (e as any)?.stack
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ;(error as any).cause = (e as any)?.cause
            throw error
        }
    }

    /**
     * Anthropic's own API takes `x-api-key`; relays in front of it sometimes
     * want a bearer token instead, or both. `config.authHeader` picks.
     */
    buildHeaders() {
        const key = this._config.value.apiKey
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            ...defaultHeaders('messages')
        }

        if (
            this.cfg.authHeader === 'bearer' ||
            this.cfg.authHeader === 'both'
        ) {
            headers.Authorization = `Bearer ${key}`
        }
        if (
            this.cfg.authHeader === 'x-api-key' ||
            this.cfg.authHeader === 'both'
        ) {
            headers['x-api-key'] = key
        }

        for (const [name, value] of this.cfg.headers) {
            if (name.length > 0) headers[name] = value
        }

        return headers
    }

    get logger() {
        return logger
    }

    /**
     * The Messages API requires max_tokens and rejects a value above the
     * model's ceiling. Prefer what the caller asked for, then the ceiling
     * resolved from the catalog, then the protocol default.
     */
    private _maxTokens(params: ModelRequestParams) {
        const ceiling =
            this._outputs.get(params.model) ??
            DEFAULT_MAX_OUTPUT_TOKENS.messages

        if (params.maxTokens == null) return ceiling
        return Math.min(params.maxTokens, ceiling)
    }
}

/**
 * A full Messages response as one message chunk.
 *
 * Not vendored: upstream only ever streamed, so the non-streaming shape had no
 * converter. Text and tool_use blocks become the chunk's content and tool calls;
 * thinking blocks ride along in `additional_kwargs` the way the streaming path
 * leaves them.
 */
function responseToChunk(body: ClaudeResponseMessage) {
    const text: string[] = []
    const reasoning: string[] = []
    const toolCalls: { id: string; name: string; args: string }[] = []
    let signature: string | undefined

    for (const block of body.content ?? []) {
        switch (block.type) {
            case 'text':
                text.push(block.text)
                break
            case 'thinking':
                reasoning.push(block.thinking)
                if (block.signature != null) signature = block.signature
                break
            case 'tool_use':
                toolCalls.push({
                    id: block.id,
                    name: block.name,
                    args: JSON.stringify(block.input ?? {})
                })
                break
            default:
                break
        }
    }

    return new AIMessageChunk({
        content: text.join(''),
        tool_call_chunks: toolCalls.map((call) => ({
            id: call.id,
            name: call.name,
            args: call.args,
            index: toolCalls.indexOf(call)
        })),
        additional_kwargs:
            reasoning.length > 0
                ? {
                      reasoning_content: reasoning.join(''),
                      ...(signature != null
                          ? { reasoning_signature: signature }
                          : {})
                  }
                : {}
    })
}
