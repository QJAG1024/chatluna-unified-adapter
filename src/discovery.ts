import { modelsCandidates } from './endpoints'

/**
 * Model listing for one endpoint.
 *
 * There is exactly one discovery path (docs/ARCHITECTURE.md §3): ask the
 * instance's own base (or the explicit `modelsURL`), and if that answers
 * nothing, report nothing. The catalog is never used as a list of ids — it
 * describes what a vendor offers, not what this endpoint serves.
 */

/** The slice of a fetch response this module reads. */
export interface ResponseLike {
    ok: boolean
    status: number
    json(): Promise<unknown>
}

export type Fetcher = (
    url: string,
    init?: Record<string, unknown>
) => Promise<ResponseLike>

export interface DiscoveryOptions {
    /** The instance's base URL. */
    base: string
    /** Explicit listing URL; when set, only it is asked. */
    modelsURL: string
    /** Also try `base/v1/models`. */
    probe: boolean
    fetch: Fetcher
    timeout: number
    signal?: AbortSignal
}

/** One listing route that was asked, and what it answered. */
export interface Attempt {
    url: string
    status?: number
    error?: string
}

export interface Discovery {
    ids: string[]
    /** Every route tried, in order. Distinguishes "no route" (404) from "not allowed" (401). */
    attempts: Attempt[]
    /**
     * Set when probing found the listing one segment deeper than the configured
     * base, i.e. `base/models` answered nothing but `base/v1/models` did. The
     * base is one segment short, so requests should follow it too.
     */
    base?: string
}

/**
 * Ask the endpoint for its model ids. Returns an empty list when no candidate
 * answers, including when the endpoint has no listing route at all (Bailian's
 * Anthropic base answers 404) — an empty list is a legal state, not an error.
 */
export async function listModels(opts: DiscoveryOptions): Promise<Discovery> {
    const candidates = modelsCandidates(opts.base, opts.modelsURL, opts.probe)
    const attempts: Attempt[] = []

    for (const url of candidates) {
        const result = await ask(url, opts)
        attempts.push(result.attempt)

        if (result.ids.length === 0) continue

        const shorter = `${opts.base.replace(/\/+$/, '')}/v1/models`
        return {
            ids: result.ids,
            attempts,
            base:
                url === shorter
                    ? shorter.slice(0, -'/models'.length)
                    : undefined
        }
    }

    return { ids: [], attempts }
}

async function ask(
    url: string,
    opts: DiscoveryOptions
): Promise<{ ids: string[]; attempt: Attempt }> {
    const listing = await fetchPage(url, opts)
    if (listing == null || listing.page == null) {
        return { ids: [], attempt: { url, status: listing?.status } }
    }

    const page = listing.page

    const ids = [...page.ids]

    // Anthropic pages with {has_more, last_id}. Follow it until it stops
    // saying there is more, bounded so a broken server cannot loop us.
    let next = page
    for (let n = 0; n < 20 && next.hasMore && next.lastId != null; n++) {
        const link = new URL(url)
        link.searchParams.set('after_id', next.lastId)
        link.searchParams.set('limit', '100')

        const fetched = await fetchPage(link.toString(), opts)
        if (fetched.page == null || fetched.page.ids.length === 0) break

        next = fetched.page
        ids.push(...next.ids)
    }

    return { ids, attempt: { url, status: listing.status } }
}

interface Page {
    ids: string[]
    hasMore?: boolean
    lastId?: string
}

async function fetchPage(
    url: string,
    opts: DiscoveryOptions
): Promise<{ page?: Page; status?: number }> {
    let body: unknown

    try {
        const response = await opts.fetch(url, {
            method: 'GET',
            headers: { accept: 'application/json' },
            signal: timeoutSignal(opts)
        })

        // A non-2xx means this route cannot list models. 404 says there is no
        // such route at all; 401/403 says the key was refused. Both are legal
        // states for discovery, but the caller wants to tell them apart.
        if (!response.ok) return { status: response.status }

        body = await response.json()
    } catch {
        // A network failure or a non-JSON body means the same thing.
        return {}
    }

    const list = arrayOf(body)
    if (list == null) return {}

    const ids: string[] = []
    for (const item of list) {
        const id = idOf(item)
        if (id != null) ids.push(id)
    }

    const raw = body as { has_more?: unknown; last_id?: unknown }
    return {
        page: {
            ids,
            hasMore: raw.has_more === true,
            lastId: typeof raw.last_id === 'string' ? raw.last_id : undefined
        }
    }
}

function timeoutSignal(opts: DiscoveryOptions) {
    const timeout = AbortSignal.timeout(opts.timeout)
    return opts.signal == null
        ? timeout
        : AbortSignal.any([timeout, opts.signal])
}

/**
 * Pull the entry array out of the shapes listings come in: OpenAI's
 * `{data: [...]}`, a `{models: [...]}`, a paging `{results: [...]}`, or a bare
 * array.
 */
function arrayOf(body: unknown): unknown[] | undefined {
    if (Array.isArray(body)) return body
    if (body == null || typeof body !== 'object') return undefined

    const record = body as Record<string, unknown>
    for (const key of ['data', 'models', 'results']) {
        if (Array.isArray(record[key])) return record[key]
    }

    return undefined
}

function idOf(item: unknown): string | undefined {
    if (typeof item === 'string') return strip(item)
    if (item == null || typeof item !== 'object') return undefined

    const record = item as Record<string, unknown>
    const raw =
        typeof record.id === 'string'
            ? record.id
            : typeof record.model === 'string'
              ? record.model
              : undefined

    return raw == null ? undefined : strip(raw)
}

/** Anthropic lists `models/claude-sonnet-4-5`; the wire wants the bare id. */
function strip(id: string) {
    return id.startsWith('models/') ? id.slice('models/'.length) : id
}
