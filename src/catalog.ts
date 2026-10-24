import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { dirname, resolve } from 'path'
import type { Context } from 'koishi'
import bundled from './data/models.dev.json'
import type { MetadataConfig } from '.'

/**
 * Model metadata from models.dev, shared by every instance in the process.
 *
 * Three layers, newest wins: a live fetch, the runtime cache on disk, and the
 * snapshot inlined at build time. `catalog()` blocks on the first two (bounded
 * by `cfg.timeout`) then returns; it never rejects.
 *
 * The state below is module-level on purpose: `reusable = true` gives each
 * config entry its own cordis fork scope, but this module is evaluated once,
 * so every instance awaits the same in-flight promise and reads the same
 * index. See docs/ARCHITECTURE.md §5.2.
 */

export interface CatalogEntry {
    /** Context window, in tokens. */
    c?: number
    /** Max output tokens. */
    o?: number
    /** Declared input modalities as initials: 't' 'i' 'p' 'a' 'v'. */
    i?: string
    /** models.dev `type`; 'chat' when the record omits it. */
    t: string
    /** Tool calling. */
    tl?: 1
    /** Reasoning. */
    r?: 1
}

export interface Snapshot {
    version: number
    source: string
    sources: string[]
    url?: string
    fetchedAt: number
    count: number
    models: Record<string, CatalogEntry>
}

/** What the adapter asks the catalog about one model id. */
export interface ModelSpec {
    context?: number
    output?: number
    modalities?: string
    type: string
    toolCall: boolean
    reasoning: boolean
}

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

const VERSION = 1
const COOLDOWN = 60 * 1000
const EMPTY = new Map<string, ModelSpec>()

let exact: Map<string, ModelSpec> | undefined
let bare: Map<string, ModelSpec> | undefined
let disk: Promise<void> | undefined
let refreshing: Promise<void> | undefined
let lastAttempt = 0
let cacheFile: string | undefined
let warn: (msg: string, ...args: unknown[]) => void = () => {}

/**
 * Resolve the metadata index for this instance.
 *
 * `refreshOnStart` and `refreshInterval` are per instance, but the underlying
 * refresh is single-flight: whichever instance gets there first fetches, and
 * the rest await it. A failed refresh keeps the previously loaded layer.
 */
export async function catalog(
    ctx: Context,
    cfg: MetadataConfig,
    fetch: Fetcher
): Promise<Map<string, ModelSpec>> {
    if (!cfg.enabled) return EMPTY

    await load(ctx)
    if (cfg.refreshOnStart) await maybeRefresh(ctx, cfg, fetch)
    if (cfg.refreshInterval > 0) {
        ctx.setInterval(() => {
            maybeRefresh(ctx, cfg, fetch)
        }, cfg.refreshInterval * 1000)
    }

    return exact
}

/**
 * Look one model up, trying the spellings gateways vary on: exact, the bare
 * tail of a `vendor/model` id, and the id with its date suffix removed.
 */
export function lookup(id: string): ModelSpec | undefined {
    if (exact == null) return undefined

    const lower = id.toLowerCase()
    const hit = exact.get(lower)
    if (hit != null) return hit

    const slash = lower.indexOf('/')
    if (slash > 0) {
        const tail = exact.get(lower.slice(slash + 1))
        if (tail != null) return tail
    } else {
        // A model resold as 'vendor/model' also answers to its bare name, but
        // only when that spelling is unambiguous across the whole catalog.
        const short = bare.get(lower)
        if (short != null) return short
    }

    // A snapshot suffix on the id: `-20250929` on one vendor, `-2025-09-29` on
    // another. Either way the record is filed under the undated name.
    return exact.get(
        lower.replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/-\d{8}$/, '')
    )
}

export function size() {
    return exact?.size ?? 0
}

export function cachePath(baseDir: string) {
    return resolve(
        baseDir,
        'data/chatluna/unified-adapter/unified-catalog.json'
    )
}

async function load(ctx: Context) {
    return (disk ??= (async () => {
        warn = (msg, ...args) =>
            ctx.logger('chatluna-unified-adapter').warn(msg, ...args)
        cacheFile = cachePath(ctx.baseDir)

        const bundledSnapshot = check(bundled as Snapshot)
        const cached = await readCache(cacheFile)
        use(
            cached != null && cached.fetchedAt > bundledSnapshot.fetchedAt
                ? cached
                : bundledSnapshot
        )
    })())
}

async function maybeRefresh(ctx: Context, cfg: MetadataConfig, fetch: Fetcher) {
    // In-flight first: a second instance must await the fetch already running,
    // not short-circuit on the cooldown and build models from stale metadata.
    if (refreshing != null) return refreshing
    if (Date.now() - lastAttempt < COOLDOWN) return

    refreshing = refresh(cfg, fetch).finally(() => {
        refreshing = undefined
    })
    return refreshing
}

async function refresh(cfg: MetadataConfig, fetch: Fetcher) {
    lastAttempt = Date.now()
    const merged: Record<string, CatalogEntry> = {}
    const done: string[] = []

    for (const source of cfg.sources) {
        const url = sourceUrl(source)
        try {
            const response = await fetch(url, {
                method: 'GET',
                headers: { accept: 'application/json' },
                signal: AbortSignal.timeout(cfg.timeout)
            })
            if (!response.ok) {
                throw new Error(`GET ${url} answered ${response.status}`)
            }
            const payload = (await response.json()) as Record<string, unknown>
            for (const [id, entry] of Object.entries(collect(payload))) {
                if (merged[id] == null) merged[id] = entry
            }
            done.push(source)
        } catch (e) {
            warn('model catalog refresh failed for %s: %s', source, e.message)
        }
    }

    // Every source failed: keep the layer already loaded.
    if (done.length === 0) return

    const snapshot: Snapshot = {
        version: VERSION,
        source: done[0],
        sources: done,
        fetchedAt: Date.now(),
        count: Object.keys(merged).length,
        models: merged
    }
    use(snapshot)
    await writeCache(cacheFile, snapshot)
}

function sourceUrl(id: string) {
    return /^https?:\/\//.test(id) ? id : 'https://models.dev/api.json'
}

function check(raw: Snapshot) {
    if (raw.version === VERSION) return raw
    warn(
        'bundled model catalog has version %s, expected %s',
        raw.version,
        VERSION
    )
    return { ...raw, version: VERSION, models: {} }
}

function use(snapshot: Snapshot) {
    const byId = new Map<string, ModelSpec>()
    const byBare = new Map<string, ModelSpec>()

    for (const [id, entry] of Object.entries(snapshot.models)) {
        const spec: ModelSpec = {
            context: entry.c,
            output: entry.o,
            modalities: entry.i,
            type: entry.t,
            toolCall: entry.tl === 1,
            reasoning: entry.r === 1
        }
        const key = id.toLowerCase()
        byId.set(key, spec)

        const slash = key.indexOf('/')
        if (slash > 0 && slash < key.length - 1) {
            const tail = key.slice(slash + 1)
            if (!byId.has(tail) && !byBare.has(tail)) byBare.set(tail, spec)
        }
    }

    exact = byId
    bare = byBare
}

async function readCache(file: string): Promise<Snapshot | undefined> {
    try {
        const raw = JSON.parse(await readFile(file, 'utf8')) as Snapshot
        if (raw.version !== VERSION) return undefined
        if (raw.models == null || typeof raw.models !== 'object')
            return undefined
        return raw
    } catch {
        return undefined
    }
}

/** Write via a temp file so a crash mid-write cannot leave half a snapshot. */
async function writeCache(file: string, snapshot: Snapshot) {
    const tmp = `${file}.${process.pid}.tmp`

    try {
        await mkdir(dirname(file), { recursive: true })
        await writeFile(tmp, JSON.stringify(snapshot))
        await rename(tmp, file)
    } catch {
        // Windows refuses to rename onto an existing file; retry once after
        // removing it. A genuine failure here only costs next-start freshness.
        try {
            await rm(file, { force: true })
            await rename(tmp, file)
        } catch (e) {
            warn('model catalog cache write failed: %s', e.message)
        }
    }
}

/**
 * Flatten models.dev's `{ provider: { models: { id: record } } }` into one
 * id -> entry map, keeping the richest record where providers disagree.
 */
function collect(payload: Record<string, unknown>) {
    const out: Record<string, CatalogEntry> = {}
    const rank: Record<string, number> = {}

    for (const provider of Object.values(payload)) {
        const list = (provider as { models?: Record<string, unknown> })?.models
        if (list == null || typeof list !== 'object') continue

        for (const [key, raw] of Object.entries(list)) {
            const entry = normalize(raw as Record<string, unknown>)
            if (entry == null) continue

            // Lowercased, like the build-time snapshot: the index keys
            // everything lowercase, so collapsing here keeps the written cache
            // the same size as the bundled one.
            const id = ((raw as { id?: string }).id || key).toLowerCase()
            const score = weight(entry)
            if (rank[id] != null && rank[id] >= score) continue

            rank[id] = score
            out[id] = entry
        }
    }

    return out
}

function normalize(raw: Record<string, unknown>): CatalogEntry | undefined {
    const limit = raw.limit as { context?: unknown; output?: unknown }
    const c = positive(limit?.context)
    const o = positive(limit?.output)
    if (c == null && o == null) return undefined

    const entry: CatalogEntry = {
        t: typeof raw.type === 'string' ? raw.type : 'chat'
    }
    if (c != null) entry.c = c
    if (o != null) entry.o = o

    const i = initials(raw.modalities)
    if (i != null) entry.i = i
    if (raw.tool_call === true) entry.tl = 1
    if (raw.reasoning === true) entry.r = 1

    return entry
}

function weight(entry: CatalogEntry) {
    let total = 0
    if (entry.c != null) total += 10
    if (entry.o != null) total += 10
    if (entry.i != null) total += 2
    if (entry.tl === 1) total += 1
    if (entry.r === 1) total += 1
    return total
}

function positive(value: unknown) {
    return typeof value === 'number' && Number.isInteger(value) && value > 0
        ? value
        : undefined
}

function initials(modalities: unknown) {
    const input = (modalities as { input?: unknown })?.input
    if (!Array.isArray(input)) return undefined

    const set = new Set<string>()
    for (const name of input) {
        const char = String(name).charAt(0).toLowerCase()
        if ('tiapv'.includes(char)) set.add(char)
    }

    return set.size > 0 ? [...set].sort().join('') : undefined
}
