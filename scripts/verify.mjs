#!/usr/bin/env node
/**
 * verify.mjs — post-build checks, run by CI after `npm run build`.
 *
 *   node scripts/verify.mjs
 *
 * Three things are checked, each for a failure that has actually happened:
 *
 *   1. The bundle exists and exports the plugin contract.
 *   2. `Config` resolves to a plausible number of fields.
 *   3. The locale lines up with the schema, in both languages.
 *
 * (3) exists because `Schema.intersect` maps the locale `$inner` array by
 * index, and index 0 is the inherited ChatLunaPlugin.Config. A locale that does
 * not leave that entry empty shifts every section title onto the group before
 * it and leaves field descriptions unmatched — the build still succeeds and the
 * damage is only visible by opening the console.
 *
 * The check therefore asserts alignment rather than mere presence: group 0 must
 * carry no title of ours, and every group and field after it must have a
 * description in *both* locales.
 */
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)
const plugin = require(resolve('lib/index.cjs'))

const LOCALES = ['zh-CN', 'en-US']

const fail = (lines) => {
    for (const line of lines) console.error(`  ${line}`)
    console.error(`::error::${lines.length} problem(s) found`)
    process.exit(1)
}

if (
    !plugin.name ||
    typeof plugin.Config !== 'function' ||
    typeof plugin.apply !== 'function'
) {
    fail(['bundle does not export name / Config / apply'])
}

const config = plugin.Config({ platform: 'ci' })
const fields = Object.keys(config).length
if (fields < 20) fail([`Config resolved to only ${fields} fields`])

/** The description of `schema` in `locale`, or undefined. */
const text = (schema, locale) => {
    const value = schema.meta.description
    if (value == null) return undefined
    if (typeof value === 'string')
        return locale === LOCALES[0] ? value : undefined
    return value[locale]
}

const groups = plugin.Config.list ?? []
const problems = []

// Index 0 is ChatLunaPlugin.Config: it brings its own text, so our locale must
// not be talking about it.
if (groups.length > 0 && groups[0].meta.description != null) {
    problems.push(
        `group 0 is ChatLunaPlugin.Config but carries a description (${JSON.stringify(groups[0].meta.description)}); the locale is shifted by one entry`
    )
}

for (const [index, group] of groups.entries()) {
    if (index === 0) continue

    for (const locale of LOCALES) {
        if (text(group, locale) == null)
            problems.push(`group ${index} has no ${locale} description`)
    }

    for (const [key, schema] of Object.entries(group.dict ?? {})) {
        for (const locale of LOCALES) {
            if (text(schema, locale) == null)
                problems.push(`${key} has no ${locale} description`)
        }

        for (const [nested, child] of Object.entries(schema.dict ?? {})) {
            for (const locale of LOCALES) {
                if (text(child, locale) == null) {
                    problems.push(
                        `${key}.${nested} has no ${locale} description`
                    )
                }
            }
        }
    }
}

if (problems.length > 0) fail(problems)

const described = groups
    .slice(1)
    .reduce(
        (count, group) => count + 1 + Object.keys(group.dict ?? {}).length,
        0
    )

console.log(
    `bundle ok: ${plugin.name} | ${fields} fields | ${groups.length} groups | ${described} described entries x ${LOCALES.length} locales`
)
