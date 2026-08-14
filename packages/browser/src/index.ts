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

import { contract, definePlugin } from "@glubean/sdk";
import type { PluginManifest } from "@glubean/sdk";
import { browserAdapter, createBrowserRoot } from "./contract/index.js";
import type { BrowserContractRoot } from "./contract/index.js";

export { browser } from "./plugin.js";
export type { ExtensionBrowserOptions } from "./plugin.js";
export { GlubeanBrowser, GlubeanPage } from "./page.js";
export { ExtensionBrowser } from "./chrome-extension/page.js";
export type {
  CloseExtensionSidePanelOptions,
  ExtensionController,
  ExtensionPage,
  ExtensionSidePanelController,
  ExtensionSidePanelHandle,
  ExtensionSidePanelTargetOptions,
  OpenExtensionSidePanelOptions,
} from "./chrome-extension/page.js";
export { connectChrome, resolveEndpoint, launchChrome } from "./chrome.js";

/**
 * Plugin manifest — installs the `contract.browser` adapter (Mode A).
 *
 * `installPlugin(browserPlugin)` registers the adapter and, in `setup()`,
 * swaps the raw dispatcher `contract.register` attached for the scoped-defaults
 * root (`.with(name, defaults)` only). This is a SEPARATE install path from the
 * `browser()` client factory (consumed via `configure({ plugins })`): the
 * client is the Mode A executor, the adapter is the contract surface.
 */
const browserPlugin: PluginManifest = definePlugin({
  name: "@glubean/browser",
  contracts: { browser: browserAdapter },
  setup() {
    const dispatcher = (
      contract as unknown as { browser: Parameters<typeof createBrowserRoot>[0] }
    ).browser;
    (contract as unknown as { browser: BrowserContractRoot }).browser =
      createBrowserRoot(dispatcher);
  },
});

export default browserPlugin;

// Contract authoring surface (types, browserCase, matchers, adapter).
export * from "./contract/index.js";
export type {
  ActionOptions,
  BrowserAction,
  BrowserEvent,
  BrowserOptions,
  BrowserPageClient,
  BrowserTestContext,
  DialogHandler,
  DialogMode,
  InstrumentedPage,
  NetworkTraceOptions,
  PuppeteerLike,
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
