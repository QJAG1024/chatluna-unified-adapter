# Vendored Anthropic Messages implementation

Everything in this directory is copied from ChatLuna's official Claude adapter.
It is here because that package's `exports` map exposes only `"."`:

```json
"exports": { ".": { ... }, "./package.json": { ... } }
```

`langchainMessageToClaudeMessage`, `convertDeltaToMessageChunk`,
`formatToolsToClaudeTools` and the thinking-block state machine all live in the
adapter's `utils.ts` / `requester.ts`, which a third-party plugin cannot import.
They are re-implemented here verbatim instead.

License: **AGPL-3.0**, same as the upstream package and this one. The original
copyright (ChatLunaLab) is retained in the file headers. This package may
therefore not be relicensed.

## Sync table

| File | Upstream path | Upstream version | Vendored | Deviations |
| --- | --- | --- | --- | --- |
| `types.ts` | `packages/adapter-claude/src/types.ts` | `1.4.0-alpha.11` | 2026-10-24 | none |
| `messages.ts` | `packages/adapter-claude/src/utils.ts` | `1.4.0-alpha.11` | 2026-10-24 | `logger` from `./logger`; file renamed |
| `requester.ts` | `packages/adapter-claude/src/requester.ts` | `1.4.0-alpha.11` | 2026-10-24 | see below |
| `logger.ts` | — | — | — | local, not vendored |

Upstream commit: `ca1177d4` (`ChatLunaLab/chatluna`, branch `v1-dev`).

## Deviations in `requester.ts`

1. `Config` / `logger` come from the local plugin entry and `./logger`, not
   from `.`.
2. `completionStreamInternal` takes its `max_tokens` ceiling from
   `_outputs` — the catalog's `limit.output` or the user's
   `maxOutputTokens` override — instead of the upstream constant `10_000`.
   Upstream's `max_tokens ?? 10_000` was a symptom of having no output-limit
   source at all; here the catalog supplies one.
3. Thinking is no longer inferred from a `-thinking` **name suffix**.
   `setModels()` and the suffix-stripping block are gone; whether a model
   reasons is decided by its catalog record (or the user's override) and
   surfaced through `ModelCapabilities.Thinking` / `isThinkModel`.
4. `listModels()` is kept because it is the correct implementation of
   Anthropic's paged listing, but **discovery does not call it**. The paging
   loop now lives in `../discovery.ts` so a listing can be fetched generically
   for any protocol. Do not route model discovery back through this method.
5. `buildHeaders()` honours `config.authHeader`
   (`bearer` / `x-api-key` / `both`) and `config.headers`, instead of
   hardcoding both auth schemes.
6. `RequestContext`-style `satisfies` typing on the request body was preserved;
   only the `thinking` field was dropped (deviation 3).

## Re-vendoring

```bash
UP=/path/to/chatluna
BASE=git -C $UP show ca1177d4:packages/adapter-claude/src

for f in types:types messages:utils requester:requester; do
    dst=${f%%:*}; src=${f##*:}
    eval $BASE/$src.ts > /tmp/up-$dst.ts
    diff -u /tmp/up-$dst.ts src/anthropic/$dst.ts
done
```

Replay the deviations listed above by hand, then update the dates in both this
table and the file headers.

Check for a new upstream release whenever
`koishi-plugin-chatluna-claude-adapter` bumps its version. Two upstream changes
already landed that this copy has to be checked against:

- **#972** — `listModels` paging and the 1M-context model mapping
- **#665** — dynamic model fetching for the Claude adapter

The `anthropic-beta` features (`interleaved-thinking-2025-05-14`,
`cache_control` TTL) are the kind of thing where upstream gains support and a
stale copy silently does not.
