/**
 * Glubean browser plugin factory.
 *
 * Uses `defineClientFactory()` from the SDK to create a lazily-initialized
 * browser connection. Returns a `GlubeanBrowser`, or an `ExtensionBrowser`
 * when unpacked extensions are configured, whose `newPage(ctx)` method creates
 * fully instrumented pages wired to the test context.
 *
 * Supports three connection modes:
 * - `launch: true` — auto-detect and start local Chrome headless
 * - `endpoint` resolving to `ws://` — direct WebSocket connection
 * - `endpoint` resolving to `http://` — auto-discover WS URL via /json/version
 *
 * @module plugin
 */

import { defineClientFactory } from "@glubean/sdk";
import type { ClientFactory, GlubeanRuntime } from "@glubean/sdk";
import type { Browser } from "puppeteer-core";
import { type BrowserOptions, GlubeanBrowser } from "./page.js";
import { connectChrome, launchChrome } from "./chrome.js";
import {
  extensionLaunchOptions,
  extensionLaunchOptionsFromResolved,
  type ExtensionLaunchOverrides,
} from "./chrome-extension/launch.js";
import {
  resolveUnpackedExtensions,
  type UnpackedExtension,
} from "./chrome-extension/manifest.js";
import { ExtensionBrowser } from "./chrome-extension/page.js";

export type ExtensionBrowserOptions = Extract<BrowserOptions, { launch: true }> & {
  extensions: string | readonly string[];
};

/**
 * Create a Glubean browser plugin.
 *
 * @param options Plugin configuration.
 *
 * @example Launch mode — zero config, auto-detects local Chrome
 * ```ts
 * import { configure, test } from "@glubean/sdk";
 * import { browser } from "@glubean/browser";
 *
 * const { chrome } = configure({
 *   plugins: {
 *     chrome: browser({ launch: true }),
 *   },
 * });
 * ```
 *
 * @example Connect mode — remote Chrome or Docker
 * ```ts
 * const { chrome } = configure({
 *   plugins: {
 *     chrome: browser({ endpoint: "CHROME_ENDPOINT" }),
 *   },
 * });
 * // .env: CHROME_ENDPOINT=http://localhost:9222
 * //   or: CHROME_ENDPOINT=ws://localhost:9222/devtools/browser/...
 * ```
 *
 * @example Full example with test.extend()
 * ```ts
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
 */
/**
 * Resolve `{{VAR}}` templates in launch options and coerce types.
 *
 * String values containing `{{...}}` are resolved via `runtime.resolveTemplate()`.
 * After resolution, `"true"/"false"` → boolean, numeric strings → number.
 */
function resolveLaunchOptions(
  raw: Record<string, unknown> | undefined,
  runtime: GlubeanRuntime,
): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  const resolved: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (typeof val === "string") {
      const str = runtime.resolveTemplate(val);
      // Coerce well-known types
      if (str === "true") resolved[key] = true;
      else if (str === "false") resolved[key] = false;
      else if (str !== "" && !isNaN(Number(str))) resolved[key] = Number(str);
      else resolved[key] = str;
    } else {
      resolved[key] = val;
    }
  }
  return resolved;
}

function resolveExtensionPaths(
  configured: string | readonly string[] | undefined,
  runtime: GlubeanRuntime,
): string | readonly string[] | undefined {
  if (configured === undefined) return undefined;
  const resolvePath = (extensionPath: string): string => {
    if (extensionPath.includes("{{")) return runtime.resolveTemplate(extensionPath);
    if (Object.prototype.hasOwnProperty.call(runtime.vars, extensionPath)) {
      return runtime.requireVar(extensionPath);
    }
    return extensionPath;
  };
  if (typeof configured === "string") return resolvePath(configured);
  return configured.map(resolvePath);
}

/** @internal Exported for focused launch-configuration tests. */
export function resolveBrowserLaunchOptions(
  options: Extract<BrowserOptions, { launch: true }>,
  runtime: GlubeanRuntime,
  resolvedExtensions?: readonly UnpackedExtension[],
): Record<string, unknown> | undefined {
  const resolvedLaunchOptions = resolveLaunchOptions(options.launchOptions, runtime);
  if (resolvedExtensions !== undefined) {
    return extensionLaunchOptionsFromResolved(
      resolvedExtensions,
      resolvedLaunchOptions as ExtensionLaunchOverrides | undefined,
    ) as unknown as Record<string, unknown>;
  }
  const extensionPaths = resolveExtensionPaths(options.extensions, runtime);
  if (extensionPaths === undefined) return resolvedLaunchOptions;
  return extensionLaunchOptions(
    extensionPaths,
    resolvedLaunchOptions as ExtensionLaunchOverrides | undefined,
  ) as unknown as Record<string, unknown>;
}

/**
 * Resolve the base URL while preserving the original bare-var-key contract.
 *
 * Unlike connection endpoints, a base URL is commonly a stable literal in a
 * checked-in surface definition. Accepting all three authoring forms keeps
 * relative `page.goto()` calls usable without forcing an otherwise-unneeded
 * configure vars alias:
 *
 * - `"APP_URL"` — runtime var key (legacy form)
 * - `"{{APP_URL}}"` — runtime template
 * - `"https://app.example.com"` — literal absolute URL
 */
function resolveBaseUrl(
  configured: string | undefined,
  runtime: GlubeanRuntime,
): string | undefined {
  if (!configured) return undefined;
  if (configured.includes("{{")) return runtime.resolveTemplate(configured);
  if (/^https?:\/\//i.test(configured)) return configured;
  return runtime.requireVar(configured);
}

export function browser(options: ExtensionBrowserOptions): ClientFactory<ExtensionBrowser>;
export function browser(options: BrowserOptions): ClientFactory<GlubeanBrowser>;
export function browser(options: BrowserOptions): ClientFactory<GlubeanBrowser> {
  return defineClientFactory((runtime: GlubeanRuntime): GlubeanBrowser => {
    const baseUrl = resolveBaseUrl(options.baseUrl, runtime);
    let browserPromise: Promise<Browser> | null = null;
    let launchConfiguration: {
      extensions?: readonly UnpackedExtension[];
      options?: Record<string, unknown>;
    } | undefined;

    const pptr = options.puppeteer;

    function getLaunchConfiguration(): NonNullable<typeof launchConfiguration> {
      if (launchConfiguration) return launchConfiguration;
      if (!("launch" in options) || !options.launch) {
        launchConfiguration = {};
        return launchConfiguration;
      }
      const extensionPaths = resolveExtensionPaths(options.extensions, runtime);
      const extensions = extensionPaths === undefined
        ? undefined
        : resolveUnpackedExtensions(extensionPaths);
      launchConfiguration = {
        extensions,
        options: resolveBrowserLaunchOptions(options, runtime, extensions),
      };
      return launchConfiguration;
    }

    function getConfiguredExtensions(): readonly UnpackedExtension[] {
      const extensions = getLaunchConfiguration().extensions;
      if (!extensions) {
        throw new Error("ExtensionBrowser requires at least one configured unpacked extension.");
      }
      return extensions;
    }

    function getBrowser(): Promise<Browser> {
      if (!browserPromise) {
        if ("launch" in options && options.launch) {
          browserPromise = launchChrome(
            options.executablePath,
            pptr,
            getLaunchConfiguration().options,
          );
        } else if ("endpoint" in options && options.endpoint) {
          if ((options as { extensions?: unknown }).extensions !== undefined) {
            throw new Error(
              "browser() cannot load local extensions in endpoint mode; use { launch: true, extensions }.",
            );
          }
          const endpoint = runtime.requireVar(options.endpoint);
          browserPromise = connectChrome(endpoint, pptr);
        } else {
          throw new Error(
            'browser() requires either { launch: true } or { endpoint: "VAR_KEY" }.',
          );
        }
      }
      return browserPromise;
    }

    const extensionMode = "launch" in options && options.launch &&
      options.extensions !== undefined;
    return extensionMode
      ? new ExtensionBrowser(getBrowser, baseUrl, options, getConfiguredExtensions)
      : new GlubeanBrowser(getBrowser, baseUrl, options);
  });
}
