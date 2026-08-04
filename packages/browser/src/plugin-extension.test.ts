import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveTemplate, type GlubeanRuntime } from "@glubean/sdk";
import { browser, resolveBrowserLaunchOptions } from "./plugin.js";

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
