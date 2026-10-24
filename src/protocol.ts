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

/**
 * The headers a request to this endpoint carries.
 *
 * One builder for every request the adapter makes — completions, listings and
 * catalog fetches alike — so a supplier that requires an odd auth shape or an
 * extra header sees it on all of them. Built here rather than in the requester
 * because discovery runs before any requester exists.
 */
export function buildHeaders(
    protocol: UnifiedProtocol,
    key: string,
    authHeader: AuthHeader,
    extra: [string, string][]
): Record<string, string> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...defaultHeaders(protocol)
    }

    if (authHeader === 'bearer' || authHeader === 'both') {
        headers.Authorization = `Bearer ${key}`
    }
    if (authHeader === 'x-api-key' || authHeader === 'both') {
        headers['x-api-key'] = key
    }

    for (const [name, value] of extra) {
        if (name.length > 0) headers[name] = value
    }

    return headers
}
