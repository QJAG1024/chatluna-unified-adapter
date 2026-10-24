/**
 * Base-URL handling shared by discovery and the requester.
 *
 * Every base follows chatluna's own convention: it already contains the API
 * version segment (`…/compatible-mode/v1`, `…/apps/anthropic/v1`). Nothing here
 * rewrites a base except the `/v1` probe, which only fires when a models listing
 * was found one segment deeper than the base says.
 */

/** Trailing slashes off, so concatenation never doubles them. */
export function trimUrl(url: string) {
    return url.replace(/\/+$/, '')
}

/** Append a path to a base, keeping the base's own version segment intact. */
export function joinUrl(base: string, path: string) {
    return `${trimUrl(base)}/${path.replace(/^\/+/, '')}`
}

/**
 * Where to look for a models listing, in order.
 *
 * An explicit `modelsURL` is asked and nothing else: the base URLs list
 * nothing, or list the wrong thing. Otherwise the base is asked, and with
 * `probe` enabled the `/v1` spelling behind it — a base typed one segment short
 * is the common mistake, and probing only the listing path never changes what
 * a completion request goes to.
 */
export function modelsCandidates(
    base: string,
    modelsURL: string,
    probe: boolean
): string[] {
    if (modelsURL.length > 0) return [modelsURL]

    const trimmed = trimUrl(base)
    const candidates = [joinUrl(trimmed, 'models')]

    if (probe && !/\/v1$/.test(trimmed) && !/\/v\d+[a-z]*$/i.test(trimmed)) {
        candidates.push(`${trimmed}/v1/models`)
    }

    return candidates
}
