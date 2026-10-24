/**
 * Wire protocols this adapter can speak, one per plugin instance.
 *
 * The adapter never translates between them: `protocol` picks the wire at
 * load time, and the rest of the plugin only knows about that one wire.
 */
export type UnifiedProtocol = 'chat' | 'responses' | 'messages'

/** Auth header shapes seen across OpenAI-compatible and Anthropic relays. */
export type AuthHeader = 'bearer' | 'x-api-key' | 'both'

export const PROTOCOLS: UnifiedProtocol[] = ['chat', 'responses', 'messages']

/** Path appended to the configured base for a chat turn. */
export function completionPath(protocol: UnifiedProtocol): string {
    switch (protocol) {
        case 'chat':
            return 'chat/completions'
        case 'responses':
            return 'responses'
        case 'messages':
            return 'messages'
    }
}

/**
 * Auth headers each protocol's own vendor expects. A relay in front of one of
 * them may want the other shape, which is what `config.authHeader` overrides.
 */
export function defaultAuthHeader(protocol: UnifiedProtocol): AuthHeader {
    return protocol === 'messages' ? 'both' : 'bearer'
}

/**
 * Extra headers the vendor's own API sends. Relays usually tolerate them and
 * sometimes require them, so they go out unless the user overrides the key.
 */
export function defaultHeaders(protocol: UnifiedProtocol) {
    return protocol === 'messages' ? { 'anthropic-version': '2023-06-01' } : {}
}

/**
 * The `max_tokens` ceiling a request uses when neither the caller, the user's
 * override, nor the catalog states an output limit. Anthropic's Messages API
 * requires a value, the OpenAI-shaped ones do not.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS: Partial<
    Record<UnifiedProtocol, number>
> = {
    messages: 8192
}

/** Whether a protocol can serve embeddings and rerankers at all. */
export function supportsEmbeddings(protocol: UnifiedProtocol) {
    return protocol === 'chat'
}
