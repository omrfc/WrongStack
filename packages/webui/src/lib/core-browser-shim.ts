/**
 * Browser-safe shim for `@wrongstack/core`.
 *
 * The webui browser bundle imports a small number of pure runtime helpers
 * (currently only `expectDefined`) from `@wrongstack/core`. The real core
 * barrel pulls in Node built-ins (`crypto`, `fs/promises`, `path`, ...) which
 * Rollup cannot externalize as named browser imports, breaking the Vite build.
 *
 * `vite.config.ts` aliases the bare `@wrongstack/core` specifier to this file
 * for the browser build only. The Node-side server build (tsup) and the
 * type-checker (tsc) continue to resolve the real package, so type-only
 * imports (`import type { Usage } from '@wrongstack/core'`) are unaffected —
 * they are erased before Vite ever resolves them.
 *
 * Re-export the narrow helper subpath so the implementation still has a
 * single source of truth without pulling in the Node-oriented core barrel.
 */
export { expectDefined } from '@wrongstack/core/utils/expect-defined';
export { normalizedEqual } from '@wrongstack/core/execution/prompt-enhancer';
export { toErrorMessage } from '@wrongstack/core/utils/error';
