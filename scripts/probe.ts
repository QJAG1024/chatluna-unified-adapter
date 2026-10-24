#!/usr/bin/env node
/**
 * probe.ts — check discovery and metadata against a real endpoint, by hand.
 *
 *   yarn probe <baseURL> [apiKey] [protocol]
 *
 * Prints what the adapter would find for that base: which listing route
 * answered, the model ids, and the metadata each id resolves to. Use it to
 * confirm a supplier's quirks before wiring a plugin instance to it.
 *
 * Deliberately not a test: no assertions, no runner, no framework. Read the
 * output. It imports nothing that needs a live koishi Context, so it also runs
 * on its own under tsx.
 */
import { listModels } from '../src/discovery'
import { catalog, lookup, size } from '../src/catalog'
import { completionPath, defaultAuthHeader } from '../src/protocol'
import { joinUrl } from '../src/endpoints'

const [base, apiKey = '', protocol = 'chat'] = process.argv.slice(2)

if (base == null) {
    console.error(
        'usage: yarn probe <baseURL> [apiKey] [chat|responses|messages]'
    )
    process.exit(1)
}

const kind = protocol as 'chat' | 'responses' | 'messages'
const headers: Record<string, string> = { 'content-type': 'application/json' }
const auth = defaultAuthHeader(kind)

if (apiKey.length > 0) {
    if (auth === 'bearer' || auth === 'both') {
        headers.authorization = `Bearer ${apiKey}`
    }
    if (auth === 'x-api-key' || auth === 'both') headers['x-api-key'] = apiKey
}
if (kind === 'messages') headers['anthropic-version'] = '2023-06-01'

const fetch = (url: string, init?: Record<string, unknown>) =>
    globalThis.fetch(url, {
        ...init,
        headers: { ...headers, ...(init?.headers as object) }
    } as never)

console.log(`base      ${base}`)
console.log(`protocol  ${kind} → POST ${joinUrl(base, completionPath(kind))}`)
console.log(`auth      ${auth}`)
console.log()

const found = await listModels({
    base,
    modelsURL: '',
    probe: true,
    fetch,
    timeout: 20_000
})

if (found.base != null) {
    console.log(
        `note: listing answered one segment deeper; base should be ${found.base}`
    )
}
for (const attempt of found.attempts) {
    console.log(
        `attempt   ${attempt.url} → ${attempt.status ?? 'network error'}`
    )
}
console.log(`models    ${found.ids.length}`)
if (found.ids.length === 0) {
    const statuses = found.attempts.map((it) => it.status)
    console.log(
        statuses.includes(404)
            ? '          (no listing route at all — legal, not an error)'
            : '          (route exists but refused the key — check apiKey/authHeader)'
    )
}

// Read the bundled snapshot plus, if reachable, the live catalog.
const ctx = {
    baseDir: process.cwd(),
    logger: () => ({
        warn: (...args: unknown[]) => console.warn('   ', ...args)
    })
}

await catalog(
    ctx as never,
    {
        enabled: true,
        sources: ['models.dev'],
        refreshOnStart: true,
        refreshInterval: 0,
        timeout: 20_000,
        fillCapabilities: true
    },
    fetch
)

console.log(`catalog   ${size()} entries`)

if (found.ids.length === 0) process.exit(0)

const shown = found.ids.slice(0, 60)
const width = Math.max(...shown.map((id) => id.length), 8)

console.log()
console.log(
    'id'.padEnd(width),
    'context   output   type        modalities  tool  reasoning'
)
console.log('-'.repeat(width + 56))

let hit = 0
for (const id of shown) {
    const meta = lookup(id)
    if (meta != null) hit++

    console.log(
        id.padEnd(width),
        String(meta?.context ?? '-').padEnd(9),
        String(meta?.output ?? '-').padEnd(8),
        String(meta?.type ?? '-').padEnd(11),
        String(meta?.modalities ?? '-').padEnd(11),
        (meta?.toolCall ? 'yes' : '-').padEnd(5),
        meta?.reasoning ? 'yes' : '-'
    )
}

console.log()
console.log(`matched ${hit}/${shown.length} shown ids in models.dev`)
