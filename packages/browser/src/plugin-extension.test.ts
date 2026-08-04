import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";
import { resolveTemplate, type GlubeanRuntime } from "@glubean/sdk";
import { browser, resolveBrowserLaunchOptions } from "./plugin.js";
import {
  ExtensionBrowser,
  type ExtensionBrowserOptions,
  type ExtensionPage,
} from "./index.js";

const fixture = fileURLToPath(new URL("./chrome-extension/fixtures/extension", import.meta.url));

function makeRuntime(vars: Record<string, string>): GlubeanRuntime {
  return {
    vars,
    secrets: {},
    http: {} as GlubeanRuntime["http"],
    requireVar: (key) => {
      const value = vars[key];
      if (!value) throw new Error(`Missing required variable: ${key}`);
      return value;
    },
    requireSecret: (key) => {
      throw new Error(`Missing required secret: ${key}`);
    },
    resolveTemplate: (template) => resolveTemplate(template, vars, {}),
    action: () => {},
    trace: () => {},
    event: () => {},
    log: () => {},
  };
}

describe("browser extension launch configuration", () => {
  it("returns an extension-aware browser client when extensions are configured", () => {
    const options: ExtensionBrowserOptions = {
      launch: true,
      extensions: fixture,
    };
    const client = browser(options).create(makeRuntime({}));

    expect(client).toBeInstanceOf(ExtensionBrowser);
    expectTypeOf(client).toEqualTypeOf<ExtensionBrowser>();
    expectTypeOf<Awaited<ReturnType<ExtensionBrowser["newPage"]>>>()
      .toEqualTypeOf<ExtensionPage>();
  });

  it("keeps unpacked-extension validation lazy until Chrome is requested", async () => {
    const missing = "/definitely-not-a-real-glubean-extension";
    const client = browser({
      launch: true,
      extensions: missing,
    }).create(makeRuntime({}));

    expect(client.isLaunched).toBe(true);
    await expect(client.newPage({} as never)).rejects.toThrow(
      `Chrome extension directory does not exist: ${missing}`,
    );
  });

  it("resolves extension path templates and composes Puppeteer launch options", () => {
    const options = resolveBrowserLaunchOptions({
      launch: true,
      extensions: "{{EXTENSION_PATH}}",
      launchOptions: { headless: "true", slowMo: "25" },
    }, makeRuntime({ EXTENSION_PATH: fixture }));

    expect(options).toMatchObject({
      enableExtensions: [fixture],
      pipe: true,
      headless: true,
      slowMo: 25,
    });
  });

  it("supports a bare runtime variable key for an extension path", () => {
    expect(resolveBrowserLaunchOptions({
      launch: true,
      extensions: "EXTENSION_PATH",
    }, makeRuntime({ EXTENSION_PATH: fixture }))).toMatchObject({
      enableExtensions: [fixture],
      pipe: true,
    });
  });

  it("rejects local extension paths in endpoint mode at runtime", async () => {
    const client = browser({
      endpoint: "CHROME_ENDPOINT",
      extensions: fixture,
    } as never).create(makeRuntime({
      CHROME_ENDPOINT: "ws://127.0.0.1:9222/devtools/browser/test",
    }));

    await expect(client.wsEndpoint()).rejects.toThrow(
      "cannot load local extensions in endpoint mode",
    );
  });
});
