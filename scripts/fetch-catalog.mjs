#!/usr/bin/env node
/**
 * fetch-catalog.mjs — build the offline model-metadata snapshot bundled with
 * the adapter.
 *
 *   node scripts/fetch-catalog.mjs [source ...]
 *
 * Default source: models.dev (https://models.dev/api.json, MIT). Each source
 * is normalized to the compact shape the runtime consumes and written to
 * `src/data/<id>.json`. The file is imported by `src/catalog.ts`, so it is
 * inlined into `lib/` at build time — the published package depends on no
 * external data file.
 *
 * Snapshot shape (see docs/ARCHITECTURE.md §5.4):
 *   c  limit.context            -> ModelInfo.maxTokens (context window)
 *   o  limit.output             -> max output tokens
 *   i  modalities.input initials ('t'/'i'/'p'/'a'/'v')
 *   t  type                     -> chat | embedding | reranking | ...
 *   tl tool_call                -> 1
 *   r  reasoning                -> 1
 *
 * Only ids, capacities, modalities and two capability flags are kept: display
 * names and the provider a listing came from are deliberately dropped, since
 * the adapter never attributes a model to a vendor.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DATA_DIR = join(ROOT, 'src', 'data')

const SOURCE_URLS = {
    'models.dev': 'https://models.dev/api.json'
}

const INITIALS = ['text', 'image', 'pdf', 'audio', 'video']

function sourceUrl(id) {
    if (id.startsWith('http://') || id.startsWith('https://')) return id
    const known = SOURCE_URLS[id]
    if (known == null) throw new Error(`unknown catalog source: ${id}`)
    return known
}

function positiveInt(value) {
    return typeof value === 'number' && Number.isInteger(value) && value > 0
        ? value
        : undefined
}

/** Initials of the declared input modalities, in a stable order. */
function inputInitials(modalities) {
    const input = modalities?.input
    if (!Array.isArray(input)) return undefined
    const set = new Set()
    for (const name of input) {
        const char = String(name).charAt(0).toLowerCase()
        if (INITIALS.some((m) => m.startsWith(char))) set.add(char)
    }
    return set.size > 0 ? [...set].sort().join('') : undefined
}

/** One raw models.dev model record -> compact entry (undefined if unusable). */
function normalize(raw) {
    const limit = raw.limit
    const c = positiveInt(limit?.context)
    const o = positiveInt(limit?.output)
    if (c === undefined && o === undefined) return undefined

    const entry = {}
    if (c !== undefined) entry.c = c
    if (o !== undefined) entry.o = o
    const i = inputInitials(raw.modalities)
    if (i !== undefined) entry.i = i
    // models.dev omits `type` for ordinary chat models.
    entry.t = typeof raw.type === 'string' ? raw.type : 'chat'
    if (raw.tool_call === true) entry.tl = 1
    if (raw.reasoning === true) entry.r = 1
    return entry
}

/**
 * How informative an entry is. Two providers listing the same id can disagree
 * (a relay may omit `limit` or `modalities`); the richest record wins, ties by
 * first occurrence.
 */
function score(entry) {
    let total = 0
    if (entry.c !== undefined) total += 10
    if (entry.o !== undefined) total += 10
    if (entry.i !== undefined) total += 2
    if (entry.tl === 1) total += 1
    if (entry.r === 1) total += 1
    if (entry.t !== 'chat') total += 1
    return total
}

/** Flatten every provider's model map into one id -> entry index. */
function collect(payload) {
    const models = {}
    const scores = {}
    let dropped = 0

    for (const provider of Object.values(payload)) {
        const list = provider?.models
        if (list == null || typeof list !== 'object') continue

        for (const [key, raw] of Object.entries(list)) {
            if (raw == null || typeof raw !== 'object') continue
            const entry = normalize(raw)
            if (entry === undefined) {
                dropped++
                continue
            }
            // Lowercased: 'Kimi-K3' and 'kimi-k3' are one model, and the
            // runtime index keys everything lowercase anyway.
            const id = (
                typeof raw.id === 'string' && raw.id !== '' ? raw.id : key
            ).toLowerCase()
            const value = score(entry)
            if (scores[id] !== undefined && scores[id] >= value) continue
            scores[id] = value
            models[id] = entry
        }
    }

    return { models, dropped }
}

async function main() {
    const sources = process.argv.slice(2)
    const ids = sources.length > 0 ? sources : ['models.dev']
    await mkdir(DATA_DIR, { recursive: true })

    for (const id of ids) {
        const url = sourceUrl(id)
        const response = await fetch(url, {
            headers: { accept: 'application/json' }
        })
        if (!response.ok)
            throw new Error(`GET ${url} answered ${response.status}`)
        const payload = await response.json()

        const { models, dropped } = collect(payload)
        const snapshot = {
            version: 1,
            source: id,
            sources: [id],
            url,
            fetchedAt: Date.now(),
            count: Object.keys(models).length,
            models
        }

        const file = join(DATA_DIR, `${id.replace(/[^a-z0-9._-]/gi, '_')}.json`)
        await writeFile(file, JSON.stringify(snapshot) + '\n')
        const bytes = JSON.stringify(snapshot).length
        console.log(
            `${file}: ${snapshot.count} models, ${(bytes / 1024).toFixed(1)} KiB` +
                (dropped > 0
                    ? `, ${dropped} records without a capacity dropped`
                    : '')
        )
    }
}

await main()
