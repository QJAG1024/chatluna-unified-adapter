/**
 * harness.cjs — boot a real koishi App with this adapter mounted, headless.
 *
 *   node scripts/harness.cjs <config.json> [seconds]
 *
 * A real koishi instance is the only way to see what a user sees: whether the
 * plugin loads, how many models the adapter reports, and what each model's
 * metadata resolved to. There is no test framework here (ChatLuna's rule), so
 * this is a script that prints findings and exits.
 *
 * The config file is a JSON array; each entry becomes one instance of this
 * adapter, so multi-instance behaviour (one shared catalog, separate listings)
 * is exercised the way it would be in the console.
 *
 * Plain CJS on purpose: koishi 4.18's ESM entry has a dual-package hazard
 * (`@cordisjs/loader` extends an object, not a constructor), so the working
 * import path in Node is `require`.
 */
const { resolve } = require('node:path')
const { readFileSync } = require('node:fs')

const file = process.argv.slice(2)[0]
const seconds = Number(process.argv.slice(3)[0] ?? 20)

if (file == null) {
    console.error('usage: node scripts/harness.cjs <config.json> [seconds]')
    process.exit(1)
}

const { App } = require('koishi')
const memory = require('@koishijs/plugin-database-memory').default
const chatluna = require('koishi-plugin-chatluna')
const plugin = require(resolve('lib/index.cjs'))
const configs = JSON.parse(readFileSync(resolve(file), 'utf8'))

// ModelType.all
const MODEL_TYPE_ALL = 0

const app = new App({
    prefix: ['/'],
    autoAssign: false,
    logger: { levels: { base: 2 } }
})

app.plugin(memory)

// ChatLuna itself: the adapter registers into its platform service.
app.plugin(chatluna, {
    // Keep the harness quiet: no message handling, no rendering.
    isLog: false,
    autoUpdateConversationModel: false
})

const started = []

for (const config of configs) {
    const platform = String(config.platform)

    app.plugin(
        Object.assign({}, plugin, {
            name: `${plugin.name}:${platform}`,
            apply(ctx, cfg) {
                cfg = Object.assign({}, config, cfg)
                ctx.on('ready', async () => {
                    started.push({ platform, cfg })
                })
                return plugin.apply(ctx, cfg)
            }
        }),
        config
    )
}

main().catch((e) => {
    console.error('harness failed:', e)
    process.exit(1)
})

async function main() {
    await app.start()
    await new Promise((done) => setTimeout(done, seconds * 1000))

    console.log('\n=== instances ===')
    for (const entry of started) {
        const models = app.chatluna.platform.listPlatformModels(
            entry.platform,
            MODEL_TYPE_ALL
        ).value
        console.log(
            `${entry.platform.padEnd(22)} ${String(models.length).padStart(3)} model(s)   protocol=${entry.cfg.protocol}`
        )
    }

    const all = app.chatluna.platform.listAllModels(MODEL_TYPE_ALL).value
    console.log(`\n=== ${all.length} model(s) total ===`)

    const byPlatform = new Map()
    for (const model of all) {
        const list = byPlatform.get(model.platform) ?? []
        list.push(model)
        byPlatform.set(model.platform, list)
    }

    for (const [platform, models] of byPlatform) {
        console.log(`\n-- ${platform} (${models.length}) --`)
        for (const model of models.slice(0, 12)) {
            console.log(
                `  ${model.name.padEnd(40)} ctx=${String(model.maxTokens).padEnd(9)} ${model.capabilities.join(',') || '-'}`
            )
        }
        if (models.length > 12) console.log(`  … ${models.length - 12} more`)
    }

    const unnamed = all.filter((model) => model.maxTokens == null)
    if (unnamed.length > 0) {
        console.log(`\nWARNING: ${unnamed.length} model(s) without a context window`)
    }

    await app.stop()
    process.exit(0)
}
