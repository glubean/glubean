import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveTemplate, type GlubeanRuntime } from "@glubean/sdk";
import type { BrowserTestContext } from "../page.js";
import { browser } from "../plugin.js";
import { getInstalledExtension } from "./actions.js";
import { installExtensionReadyWatcher } from "./ready.js";
import { extensionPageUrl } from "./targets.js";

const fixture = fileURLToPath(new URL("./fixtures/extension", import.meta.url));
const runSmoke =
  process.env.GLUBEAN_CHROME_EXTENSION_SMOKE === "1" ||
  process.env.npm_lifecycle_event === "test:chrome-extension:smoke";

function makeRuntime(): GlubeanRuntime {
  return {
    vars: {},
    secrets: {},
    http: {} as GlubeanRuntime["http"],
    requireVar: (key) => { throw new Error(`Missing required variable: ${key}`); },
    requireSecret: (key) => { throw new Error(`Missing required secret: ${key}`); },
    resolveTemplate: (template) => resolveTemplate(template, {}, {}),
    action: () => {},
    trace: () => {},
    event: () => {},
    log: () => {},
  };
}

const context: BrowserTestContext = {
  testId: "chrome-extension-real-smoke",
  action: () => {},
  event: () => {},
  trace: () => {},
  metric: () => {},
  log: () => {},
  warn: () => {},
};

describe.skipIf(!runSmoke)("real Chrome extension smoke", () => {
  let fixtureUrl = "";
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><html><body><main>Content fixture</main></body></html>");
  });

  beforeAll(async () => {
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolvePromise());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture server has no TCP port.");
    fixtureUrl = `http://127.0.0.1:${address.port}/fixture`;
  });

  afterAll(async () => {
    await new Promise<void>((resolvePromise, reject) => {
      server.close((error) => error ? reject(error) : resolvePromise());
    });
  });

  it("loads options, content script, and native side-panel open/close", async () => {
    const chrome = browser({ launch: true, extensions: fixture }).create(makeRuntime());
    const page = await chrome.newPage(context);

    try {
      const extension = await getInstalledExtension(page.raw.browser());
      expect(extension.path).toBe(fixture);
      await page.goto(extensionPageUrl(extension.id, "options.html"), {
        waitUntil: "domcontentloaded",
      });
      expect(await page.title()).toBe("Fixture Options");
      await page.click("#enabled");
      expect(await page.raw.$eval(
        "html",
        (element) => element.dataset.enabled,
      )).toBe("true");

      const ready = await installExtensionReadyWatcher(page.raw, {
        keys: ["__fixture"],
      });
      await page.goto(fixtureUrl, { waitUntil: "domcontentloaded" });
      expect(await ready.wait()).toEqual({ key: "__fixture", version: "1.0.0" });
      expect(await page.raw.$eval(
        "html",
        (element) => element.dataset.extensionReady,
      )).toBe("true");
      await ready.dispose();

      await expect(page.extension.sidePanel.current({
        extension: extension.id,
      })).resolves.toBeNull();

      const sidePanel = await page.extension.sidePanel.open({
        extension: extension.id,
      });
      await sidePanel.page.waitForSelector("[data-testid=sidepanel-root]");
      expect(await sidePanel.page.title()).toBe("Fixture Side Panel");
      await sidePanel.close();

      await expect(page.extension.sidePanel.current({
        extension: extension.id,
      })).resolves.toBeNull();
      const reopened = await page.extension.sidePanel.open({
        extension: extension.id,
      });
      expect(await reopened.page.title()).toBe("Fixture Side Panel");
      await reopened.close();
    } finally {
      await page.close();
      await chrome.close();
    }
  }, 30_000);
});
