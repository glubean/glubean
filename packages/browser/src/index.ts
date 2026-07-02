/**
 * @glubean/browser — Browser automation plugin for Glubean.
 *
 * Connects to or launches a Chrome instance via puppeteer-core and provides
 * auto-instrumentation: navigation tracing, network request tracing,
 * performance metrics, and console log forwarding — all wired into
 * the Glubean test context.
 *
 * @example Launch mode (zero config)
 * ```ts
 * import { configure, test } from "@glubean/sdk";
 * import { browser } from "@glubean/browser";
 *
 * const { chrome } = configure({
 *   plugins: {
 *     chrome: browser({ launch: true }),
 *   },
 * });
 *
 * const myTest = test.extend({
 *   page: async (ctx, use) => {
 *     const pg = await chrome.newPage(ctx);
 *     try {
 *       await use(pg);
 *     } finally {
 *       await pg.close();
 *     }
 *   },
 * });
 *
 * export const homepage = myTest("homepage-loads", async (ctx) => {
 *   await ctx.page.goto("/");
 *   ctx.expect(await ctx.page.title()).toBe("My App");
 * });
 * ```
 *
 * @module
 */

export { browser } from "./plugin.js";
export { GlubeanBrowser, GlubeanPage } from "./page.js";
export type {
  ActionOptions,
  BrowserAction,
  BrowserEvent,
  BrowserOptions,
  BrowserTestContext,
  DialogHandler,
  DialogMode,
  InstrumentedPage,
  PuppeteerLike,
  NetworkTraceOptions,
  ResponseChecks,
} from "./page.js";
export type {
  DownloadEntry,
  DownloadOptions,
  DownloadState,
  EmulationOptions,
  EvidenceScreenshotOptions,
  GeolocationOverride,
  MockRule,
  ScreenshotEntry,
  ScreenshotMode,
  ScreenshotTrigger,
  StorageCookie,
  StorageState,
  ViewportOverride,
} from "./evidence.js";
export type { IndexedLocator, Queryable, WrappedLocator } from "./locator.js";
export { GlubeanFrame } from "./frame.js";
export type { FrameActionOptions } from "./frame.js";
