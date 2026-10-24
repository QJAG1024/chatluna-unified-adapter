/**
 * audit.mjs — what metadata did each model actually get, and from where?
 *
 *   npx tsx scripts/audit.mjs <config.json> [--dupes] [--json]
 *
 * Boots the built plugin against the config, then for every model ChatLuna holds
 * reports the metadata it ended up with and which layer supplied it:
 *
 *   catalog    models.dev had the id (context / output / modalities / reason)
 *   heuristic  chatluna's existing name matchers answered
 *   fallback   nothing knew it, so the shared default applied
 *   override   the user's modelOverrides entry set the field
 *
 * The point is to find models that silently degrade — a vision model without
 * image_input, a long-context model stuck at 200k — without sending requests.
 *
 * Run under tsx so the source catalog can be imported directly; host modules
 * come through createRequire because koishi 4.18's ESM entry has a dual-package
 * hazard in this Node version.
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { catalog, lookup } from '../src/catalog.ts'

const HOST = '/home/qjag186/Documents/koishi-dev/'
const host = createRequire(HOST)

const { App } = host('koishi')
const memory = host('@koishijs/plugin-database-memory').default
const chatluna = host('koishi-plugin-chatluna')
const { getModelMaxContextSizeByName } = host('@chatluna/v1-shared-adapter')
const plugin = host(resolve('lib/index.cjs'))

const file = process.argv.slice(2)[0]
const asJson = process.argv.includes('--json')

if (file == null) {
    console.error('usage: npx tsx scripts/audit.mjs <config.json> [--json]')
    process.exit(1)
}

const configs = JSON.parse(readFileSync(resolve(file), 'utf8'))

// A fresh, independent index: compare what a model *should* get against what
// the running plugin actually gave it.
await catalog(
    { baseDir: HOST, logger: () => ({ warn: () => {} }) },
    {
        enabled: true,
        sources: [],
        refreshOnStart: false,
        refreshInterval: 0,
        timeout: 5000,
        fillCapabilities: true
    },
    async () => {
        throw new Error('offline audit')
    }
)

const app = new App({
    prefix: ['/'],
    autoAssign: false,
    logger: { levels: { base: 2 } }
})
app.plugin(memory)
app.plugin(chatluna, { isLog: false, autoUpdateConversationModel: false })

for (const config of configs) {
    const platform = String(config.platform)
    app.plugin(
        Object.assign({}, plugin, {
            name: `${plugin.name}:${platform}`,
            apply: (ctx, cfg) =>
                plugin.apply(ctx, Object.assign({}, config, cfg))
        }),
        config
    )
}

app.on('ready', () => setTimeout(main, 15_000))
app.start().catch((e) => {
    console.error(e)
    process.exit(1)
})

async function main() {
    const all = app.chatluna.platform.listAllModels(0).value
    const rows = all.map((model) => describe(model, configs))

    if (asJson) {
        console.log(JSON.stringify(rows, null, 2))
        return finish()
    }

    for (const config of configs) {
        const mine = rows.filter((row) => row.platform === config.platform)
        if (mine.length === 0) continue

        const sources = tally(mine)
        console.log(
            `\n=== ${config.platform} (${config.protocol}, ${mine.length} models) ===\n` +
                'source: ' +
                Object.entries(sources)
                    .map(([k, v]) => `${k}=${v}`)
                    .join('  ')
        )

        const suspect = mine.filter(
            (row) => row.source !== 'catalog' && looksCapable(row.name)
        )
        if (suspect.length > 0) {
            console.log(
                `\n  ${suspect.length} name(s) suggesting vision/omni, but metadata did not come from the catalog:`
            )
            for (const row of suspect.slice(0, 20)) {
                console.log(
                    `    ${row.name.padEnd(40)} ctx=${String(row.context).padEnd(8)} ${row.capabilities.join(',')}`
                )
            }
        }

        // A context window far below what the vendor's own listing implies.
        const cramped = mine.filter(
            (row) =>
                row.catalogContext != null &&
                row.context < row.catalogContext * 0.5
        )
        if (cramped.length > 0) {
            console.log(
                `\n  ${cramped.length} model(s) with a context below the catalog value:`
            )
            for (const row of cramped.slice(0, 10)) {
                console.log(
                    `    ${row.name.padEnd(40)} ctx=${row.context} (catalog ${row.catalogContext}) override=${row.override}`
                )
            }
        }
    }

    const seen = new Map()
    for (const row of rows) {
        const list = seen.get(row.name) ?? []
        list.push(row.platform)
        seen.set(row.name, list)
    }
    const dupes = [...seen].filter(([, p]) => p.length > 1)
    if (dupes.length > 0) {
        console.log(
            `\n=== ${dupes.length} id(s) listed by more than one instance ===`
        )
        for (const [name, platforms] of dupes.slice(0, 10)) {
            console.log(`  ${name.padEnd(40)} ${platforms.join(', ')}`)
        }
    }

    const empty = rows.filter((row) => row.capabilities.length === 0)
    if (empty.length > 0) {
        console.log(`\n=== ${empty.length} model(s) with no capabilities ===`)
        for (const row of empty.slice(0, 10))
            console.log(`  ${row.platform}/${row.name}`)
    }

    const bad = rows.filter((row) => !(row.context > 0))
    if (bad.length > 0)
        console.log(
            `\nWARNING: ${bad.length} model(s) without a context window`
        )

    finish()
}

/** Which layer supplied this model's numbers, by comparing against each. */
function describe(model, configs) {
    const config = configs.find((c) => c.platform === model.platform)
    const override = config?.modelOverrides?.[model.name]
    const meta = lookup(model.name)
    const fallback = getModelMaxContextSizeByName(model.name)

    let source
    if (
        override?.contextSize != null &&
        override.contextSize === model.maxTokens
    ) {
        source = 'override'
    } else if (meta?.context != null && meta.context === model.maxTokens) {
        source = 'catalog'
    } else if (model.maxTokens === fallback) {
        source = 'fallback'
    } else {
        source = 'heuristic'
    }

    return {
        platform: model.platform,
        name: model.name,
        type: model.type,
        context: model.maxTokens,
        catalogContext: meta?.context,
        catalogOutput: meta?.output,
        capabilities: model.capabilities ?? [],
        source,
        override: override?.contextSize ?? null
    }
}

function looksCapable(name) {
    const lower = name.toLowerCase()
    return ['vl', 'vision', 'omni', 'ocr', 'seedream', 'cogview', 'image'].some(
        (word) => lower.includes(word)
    )
}

function tally(rows) {
    const out = {}
    for (const row of rows) out[row.source] = (out[row.source] ?? 0) + 1
    return out
}

async function finish() {
    await app.stop()
    process.exit(0)
}
