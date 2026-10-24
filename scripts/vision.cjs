/**
 * vision.cjs — send one image through a mounted instance and print the reply.
 *
 *   node scripts/vision.cjs <config.json> <platform/model> [image.png]
 *
 * Boots the built plugin, builds a ChatLunaMessage with an `image_url` content
 * part the way ChatLuna's own image interceptor does, and reports whether the
 * model actually described the picture. Cheaper than clicking through a bot
 * client when the question is "does the image path work at all".
 */
const { resolve } = require('node:path')
const { readFileSync } = require('node:fs')

const [file, target, imagePath = '/tmp/red.png'] = process.argv.slice(2)

if (file == null || target == null) {
    console.error('usage: node scripts/vision.cjs <config.json> <platform/model> [image.png]')
    process.exit(1)
}

const { App } = require('koishi')
const memory = require('@koishijs/plugin-database-memory').default
const chatluna = require('koishi-plugin-chatluna')
const { HumanMessage } = require('@langchain/core/messages')
const plugin = require(resolve('lib/index.cjs'))
const configs = JSON.parse(readFileSync(resolve(file), 'utf8'))

const imageUrl =
    'data:image/png;base64,' + readFileSync(resolve(imagePath)).toString('base64')

const app = new App({ prefix: ['/'], autoAssign: false, logger: { levels: { base: 2 } } })
app.plugin(memory)
app.plugin(chatluna, { isLog: true, autoUpdateConversationModel: false })

for (const config of configs) {
    const platform = String(config.platform)
    app.plugin(
        Object.assign({}, plugin, {
            name: `${plugin.name}:${platform}`,
            apply: (ctx, cfg) => plugin.apply(ctx, Object.assign({}, config, cfg))
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
    const [platform, ...rest] = target.split('/')
    const model = rest.join('/')

    const info = app.chatluna.platform.findModel(platform, model).value
    console.log(`\n=== ${target} ===`)
    console.log('info:', JSON.stringify(info))
    if (info == null) process.exit(1)

    const supportsImage = (info.capabilities ?? []).includes('image_input')
    console.log('capabilities include image_input:', supportsImage)

    const ref = await app.chatluna.createChatModel(platform, model)

    // The same content-part shape ChatLuna's image interceptor produces.
    const message = new HumanMessage({
        content: [
            { type: 'text', text: 'What colour is this image? Answer with one word.' },
            { type: 'image_url', image_url: { url: imageUrl } }
        ]
    })

    const started = Date.now()
    const reply = await ref.value.invoke([message])
    console.log(`\nreply (${Date.now() - started} ms):`, JSON.stringify(reply.content))
    console.log('usage:', JSON.stringify(reply.usage_metadata ?? null))

    await app.stop()
    process.exit(0)
}
