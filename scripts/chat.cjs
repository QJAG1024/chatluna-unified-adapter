/**
 * chat.cjs — run one real chat turn through a mounted instance.
 *
 *   node scripts/chat.cjs <config.json> <platform/model> [prompt] [seconds]
 *
 * Boots koishi with the built plugin, creates the model through ChatLuna's own
 * service (so the real `_createModel` path runs), and prints the reply. This is
 * the only check that covers the wire end to end: message conversion, streaming,
 * usage, and tool-call plumbing all run exactly as they do for a user.
 *
 * Plain CJS for the same reason as harness.cjs: koishi 4.18's ESM entry has a
 * dual-package hazard in this Node version.
 */
const { resolve } = require('node:path')
const { readFileSync } = require('node:fs')

const [file, target, prompt = 'Say "ok" and nothing else.', seconds = '40'] =
    process.argv.slice(2)

if (file == null || target == null) {
    console.error(
        'usage: node scripts/chat.cjs <config.json> <platform/model> [prompt] [seconds]'
    )
    process.exit(1)
}

const { App } = require('koishi')
const memory = require('@koishijs/plugin-database-memory').default
const chatluna = require('koishi-plugin-chatluna')
const { HumanMessage } = require('@langchain/core/messages')
const { DynamicStructuredTool } = require('@langchain/core/tools')
const { z } = require('zod')
const plugin = require(resolve('lib/index.cjs'))
const configs = JSON.parse(readFileSync(resolve(file), 'utf8'))

const app = new App({
    prefix: ['/'],
    autoAssign: false,
    logger: { levels: { base: 2 } }
})

app.plugin(memory)
app.plugin(chatluna, { isLog: true, autoUpdateConversationModel: false })

for (const config of configs) {
    const platform = String(config.platform)
    app.plugin(
        Object.assign({}, plugin, {
            name: `${plugin.name}:${platform}`,
            apply(ctx, cfg) {
                return plugin.apply(ctx, Object.assign({}, config, cfg))
            }
        }),
        config
    )
}

main().catch((e) => {
    console.error('chat failed:', e)
    process.exit(1)
})

async function main() {
    await app.start()
    await new Promise((done) => setTimeout(done, 12_000))

    const [platform, ...rest] = target.split('/')
    const model = rest.join('/')

    console.log(`\n=== ${target} ===`)
    const info = app.chatluna.platform.findModel(platform, model).value
    console.log('modelInfo:', JSON.stringify(info))

    if (info == null) {
        console.error('model not found; is it listed by the adapter?')
        process.exit(1)
    }

    const ref = await app.chatluna.createChatModel(platform, model)
    const chat = ref.value
    console.log('modelMaxContextSize:', chat.getModelMaxContextSize())
    console.log('invocation:', JSON.stringify(chat.invocationParams()))

    const started = Date.now()
    const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timed out')), Number(seconds) * 1000)
    )

    // A tool the model can call, to exercise tool_use / tool_result on the wire.
    const weather = new DynamicStructuredTool({
        name: 'get_weather',
        description: 'Get the weather for a city. Call this when asked about weather.',
        schema: z.object({ city: z.string().describe('City name') }),
        func: async ({ city }) => `${city}: 21C, clear`
    })

    // ChatLunaChatModel drives streaming through `_generate`, not a public
    // `stream()`; asking it for a non-streamed result and reading the aggregated
    // message is the same path a chat turn takes.
    const chunks = []
    const consumer = (async () => {
        const result = await chat.invoke([new HumanMessage(prompt)], {
            tools: process.env.TOOLS === '1' ? [weather] : undefined
        })
        const text = typeof result.content === 'string' ? result.content : ''
        process.stdout.write(text)
        chunks.push(result)
    })()

    await Promise.race([consumer, timeout])

    const last = chunks[chunks.length - 1]
    console.log(`\n\n=== done in ${Date.now() - started} ms ===`)
    console.log('usage:', JSON.stringify(last?.usage_metadata ?? null))

    const toolCalls = last?.tool_calls ?? []
    if (toolCalls.length > 0) {
        console.log('tool calls:', JSON.stringify(toolCalls))
    }

    await app.stop()
    process.exit(0)
}
