/**
 * Browser contract surface for @glubean/browser.
 *
 * This module is **side-effect-free** — it only re-exports the adapter,
 * factory, matchers, and types so the manifest in `../index.ts` can reference
 * them. Projects install the manifest via `installPlugin(browserPlugin)`
 * (the default export of `@glubean/browser`).
 */

export { browserAdapter } from "./adapter.js";
export { createBrowserFactory, createBrowserRoot } from "./factory.js";
export {
  matchCalls,
  matchConsole,
  matchUrl,
  parseHttpEndpoint,
  pathTemplateToRegExp,
  pathnameOf,
  resolveLocator,
  describeLocator,
} from "./matchers.js";
export { defineBrowserCase } from "./types.js";
export type {
  BrowserConsoleError,
  BrowserContractCase,
  BrowserContractDefaults,
  BrowserContractFactory,
  BrowserContractMeta,
  BrowserContractRoot,
  BrowserContractSafeMeta,
  BrowserContractSpec,
  BrowserEvidence,
  BrowserExpect,
  BrowserFlowCaseOutput,
  BrowserLocatorSpec,
  BrowserPayloadSchemas,
  BrowserSafeSchemas,
  BrowserScreenshotStrategy,
  BrowserStep,
  BrowserTraceRecord,
  ConsoleExpect,
  DomExpect,
  UrlExpect,
} from "./types.js";
export type { CallsMatchResult, ConsoleMatchResult, UrlMatchResult } from "./matchers.js";
