import type { LaunchOptions } from "puppeteer-core";
import { resolveUnpackedExtensions } from "./manifest.js";

/** Launch options accepted by Puppeteer, excluding its extension switch. */
export type ExtensionLaunchOverrides = Omit<LaunchOptions, "enableExtensions">;

/**
 * Build Puppeteer launch options for one or more unpacked extensions.
 *
 * Puppeteer's extension transport requires `pipe: true`. Visible Chrome is the
 * default because toolbar actions and native side panels are user-facing UI;
 * callers may opt into headless mode explicitly for compatible surfaces.
 */
export function extensionLaunchOptions(
  extensionPaths: string | readonly string[],
  overrides: ExtensionLaunchOverrides = {},
): LaunchOptions {
  if (overrides.pipe === false) {
    throw new Error(
      "Puppeteer requires pipe: true when loading unpacked Chrome extensions with enableExtensions.",
    );
  }
  if (overrides.args?.some((arg) => arg.startsWith("--remote-debugging-"))) {
    throw new Error(
      "Do not set --remote-debugging-port or --remote-debugging-pipe in extension launch args; Puppeteer owns the required pipe transport.",
    );
  }
  const extensions = resolveUnpackedExtensions(extensionPaths);
  return {
    ...overrides,
    headless: overrides.headless ?? false,
    pipe: true,
    enableExtensions: extensions.map((extension) => extension.path),
  };
}
