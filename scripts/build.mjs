#!/usr/bin/env node
/**
 * build.mjs — bundle the plugin the way chatluna's own packages are built.
 *
 *   node scripts/build.mjs [--dev]
 *
 * `atsc -b` emits the `.d.ts` files (and copies non-TS assets); esbuild then
 * bundles `src/index.ts` into `lib/index.{cjs,mjs}`. Chatluna's packages ship
 * both formats because koishi may load either.
 *
 * The `.yml` locales and the model-catalog snapshot are inlined into the
 * bundle, so the published `lib/` depends on no data file at runtime.
 *
 * Everything chatluna provides stays external: this is a plugin, not a fork of
 * the host.
 */
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const dev = process.argv.includes('--dev')

const external = [
    'koishi',
    '@koishijs/*',
    'koishi-plugin-chatluna',
    'koishi-plugin-chatluna/*',
    'koishi-plugin-chatluna-*',
    '@chatluna/*',
    '@langchain/*',
    'cordis',
    '@cordisjs/*',
    'undici',
    'zod',
    'zod-to-json-schema'
]

/** Inline `.yml` as a JSON module, matching how chatluna's build handles it. */
const yamlPlugin = {
    name: 'yaml',
    setup(build) {
        build.onLoad({ filter: /\.ya?ml$/ }, async (args) => {
            const source = await readFile(args.path, 'utf8')
            return {
                contents: JSON.stringify(yaml.load(source)),
                loader: 'json'
            }
        })
    }
}

const common = {
    entryPoints: [resolve(ROOT, 'src/index.ts')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    external,
    plugins: [yamlPlugin],
    logLevel: 'info',
    minify: !dev,
    sourcemap: dev,
    // Keep the vendored Anthropic files readable in stack traces.
    keepNames: true
}

await build({
    ...common,
    outfile: resolve(ROOT, 'lib/index.cjs'),
    format: 'cjs'
})

await build({
    ...common,
    outfile: resolve(ROOT, 'lib/index.mjs'),
    format: 'esm'
})
