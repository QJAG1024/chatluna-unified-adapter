import type { Logger } from 'koishi'

/**
 * Logger handle for the vendored Anthropic Messages code.
 *
 * Upstream imports `logger` from the plugin entry; that entry is not this
 * package's, so the handle is set once at plugin load.
 */
export let logger: Logger

export function setLogger(value: Logger) {
    logger = value
}
