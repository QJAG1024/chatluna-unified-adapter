import { createRequire } from 'node:module'
const host = createRequire('/home/qjag186/Documents/koishi-dev/')
// Preload koishi so @chatluna/v1-shared-adapter's dependency resolves.
host('koishi')
const { catalog, lookup } = await import('./src/catalog.ts')
const { specOf } = await import('./src/spec.ts')
const ctx = { baseDir: '/tmp/uh/y', logger: () => ({ warn: () => {} }) }
await catalog(ctx, { enabled: true, sources: [], refreshOnStart: false, refreshInterval: 0, timeout: 1000, fillCapabilities: true }, async () => { throw new Error('x') })
for (const id of ['deepseek-v4.1-flash-1017','deepseek-v4.1-flash','qwen3.8-flash','claude-opus-4-5-20251101']) {
  const meta = lookup(id)
  const s = specOf(id, undefined, meta, true)
  console.log(id.padEnd(30), 'ctx', s.info.maxTokens, '| catalog out', meta?.output, '-> max_tokens', s.output)
}
const s = specOf('x', { maxOutputTokens: 999999, contextSize: 1000000 }, undefined, true)
console.log('override honoured as written:', s.output)
