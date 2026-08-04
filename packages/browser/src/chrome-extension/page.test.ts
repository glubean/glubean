import { fileURLToPath } from "node:url";
import type {
  Browser,
  Extension,
  Page,
  Target,
  WebWorker,
} from "puppeteer-core";
import { describe, expect, it, vi } from "vitest";
import {
  GlubeanPage,
  type BrowserTestContext,
  type GlubeanBrowser,
  type InstrumentedPage,
} from "../page.js";
import { resolveUnpackedExtension } from "./manifest.js";
import { attachExtensionCapabilities } from "./page.js";

const fixture = fileURLToPath(new URL("./fixtures/extension", import.meta.url));

interface ExtensionHarness {
  browser: Browser;
  extension: Extension;
  host: InstrumentedPage;
  panel: Page;
  triggerAction: ReturnType<typeof vi.fn>;
  workerEvaluate: ReturnType<typeof vi.fn>;
}

function createHarness(options: { markPageClosedOnClose?: boolean } = {}): ExtensionHarness {
  let panelOpen = false;
  let panelClosed = false;
  const panelTarget = {} as Target;
  const panel = {
    isClosed: () => panelClosed,
    target: () => panelTarget,
    title: async () => "Fixture Side Panel",
    url: () => "chrome-extension://abc123/sidepanel.html?tab=7#/home",
  } as unknown as Page;

  const triggerAction = vi.fn(async () => {
    panelOpen = true;
    panelClosed = false;
  });
  const workerEvaluate = vi.fn(async (
    _fn: (...args: never[]) => unknown,
    _windowId?: number,
  ) => {
    panelOpen = false;
    panelClosed = options.markPageClosedOnClose ?? true;
  });
  const worker = { evaluate: workerEvaluate } as unknown as WebWorker;
  const workerTarget = {
    type: () => "service_worker",
    url: () => "chrome-extension://abc123/background.js",
    worker: async () => worker,
  } as unknown as Target;

  const extension = {
    id: "abc123",
    name: "Fixture Extension",
    version: "1.0.0",
    path: fixture,
    enabled: true,
    pages: async () => panelOpen ? [panel] : [],
    workers: async () => [worker],
    triggerAction,
  } as unknown as Extension;
  const browser = {
    extensions: async () => new Map([[extension.id, extension]]),
    targets: () => [workerTarget],
  } as unknown as Browser;
  const hostRaw = { browser: () => browser } as unknown as Page;
  const host = { raw: hostRaw } as InstrumentedPage;

  return {
    browser,
    extension,
    host,
    panel,
    triggerAction,
    workerEvaluate,
  };
}

describe("extension-scoped page capabilities", () => {
  it("opens, finds, closes, and reopens the manifest-declared side panel", async () => {
    const harness = createHarness();
    const page = attachExtensionCapabilities(harness.host, [
      resolveUnpackedExtension(fixture),
    ]);

    await expect(page.extension.sidePanel.current()).resolves.toBeNull();

    const first = await page.extension.sidePanel.open({
      timeout: 500,
      interval: 1,
    });
    expect(first.page).toBe(harness.panel);
    expect(first.extensionId).toBe("abc123");
    expect(first.path).toBe("sidepanel.html");
    expect(harness.triggerAction).toHaveBeenCalledWith(page.raw);

    const current = await page.extension.sidePanel.current();
    expect(current?.page).toBe(harness.panel);

    await first.close({ windowId: 7, timeout: 500, interval: 1 });
    expect(harness.workerEvaluate).toHaveBeenCalledOnce();
    expect(harness.workerEvaluate.mock.calls[0]?.[1]).toBe(7);
    await expect(page.extension.sidePanel.current()).resolves.toBeNull();

    const reopened = await page.extension.sidePanel.open({
      timeout: 500,
      interval: 1,
    });
    expect(reopened.page).toBe(harness.panel);
    expect(harness.triggerAction).toHaveBeenCalledTimes(2);
  });

  it("keeps the extension capability off the generic enumerable page surface", () => {
    const harness = createHarness();
    const page = attachExtensionCapabilities(harness.host, [
      resolveUnpackedExtension(fixture),
    ]);

    expect(page).toHaveProperty("extension.sidePanel.open");
    expect(Object.keys(page)).not.toContain("extension");
  });

  it("attaches to a real InstrumentedPage Proxy without exposing an enumerable field", async () => {
    const harness = createHarness();
    const cdp = {
      send: async () => ({}),
      on() { return this; },
      off() { return this; },
      detach: async () => {},
    };
    const raw = {
      browser: () => harness.browser,
      createCDPSession: async () => cdp,
      on() { return this; },
      url: () => "https://example.test/",
    } as unknown as Page;
    const ctx: BrowserTestContext = {
      action: () => {},
      event: () => {},
      trace: () => {},
      metric: () => {},
      log: () => {},
      warn: () => {},
    };
    const proxy = await GlubeanPage._create(raw, undefined, ctx, {
      launch: true,
      consoleForward: false,
      networkTrace: false,
      passive: true,
      screenshot: "off",
    });
    const page = attachExtensionCapabilities(proxy, [
      resolveUnpackedExtension(fixture),
    ]);

    expect(page.extension.sidePanel.open).toBeTypeOf("function");
    expect(Object.keys(page)).not.toContain("extension");
    expect(() => attachExtensionCapabilities(page, [])).toThrow(
      "capabilities are already attached",
    );
  });

  it("registers returned panel pages with the owning browser lifecycle", async () => {
    const harness = createHarness();
    const track = vi.fn();
    const owner = { _track: track } as unknown as GlubeanBrowser;
    const page = attachExtensionCapabilities(harness.host, [
      resolveUnpackedExtension(fixture),
    ], owner);

    const panel = await page.extension.sidePanel.open({ timeout: 500, interval: 1 });

    expect(track).toHaveBeenCalledWith(panel.page);
  });

  it("forwards extension selection and supports an explicit side-panel path", async () => {
    const harness = createHarness();
    const page = attachExtensionCapabilities(harness.host, []);

    const handle = await page.extension.sidePanel.open({
      extension: harness.extension.id,
      pagePath: "/sidepanel.html?tab=7#/home",
      timeout: 500,
      interval: 1,
    });

    expect(handle.path).toBe("sidepanel.html");
  });

  it("rejects ambiguous active side-panel pages", async () => {
    const harness = createHarness();
    const second = {
      isClosed: () => false,
      url: () => "chrome-extension://abc123/sidepanel.html?window=2",
    } as unknown as Page;
    harness.extension.pages = async () => [harness.panel, second];
    const page = attachExtensionCapabilities(harness.host, [
      resolveUnpackedExtension(fixture),
    ]);

    await expect(page.extension.sidePanel.current()).rejects.toThrow(
      "Multiple active side-panel pages matched",
    );
    await expect(page.extension.sidePanel.open({
      timeout: 500,
      interval: 1,
    })).rejects.toThrow("Multiple active side-panel pages matched");
  });

  it("rejects open when the matching panel is already active", async () => {
    const harness = createHarness();
    const page = attachExtensionCapabilities(harness.host, [
      resolveUnpackedExtension(fixture),
    ]);
    await page.extension.sidePanel.open({ timeout: 500, interval: 1 });

    await expect(page.extension.sidePanel.open({
      timeout: 500,
      interval: 1,
    })).rejects.toThrow("side panel is already open");
    expect(harness.triggerAction).toHaveBeenCalledOnce();
  });

  it("forwards extension discovery timing controls from current()", async () => {
    const browser = {
      extensions: async () => new Map(),
    } as unknown as Browser;
    const host = {
      raw: { browser: () => browser } as unknown as Page,
    } as InstrumentedPage;
    const page = attachExtensionCapabilities(host, []);

    await expect(page.extension.sidePanel.current({
      timeout: 0,
      interval: 1,
    })).rejects.toThrow("within 0ms");
  });

  it("rejects empty explicit paths and missing manifest declarations", async () => {
    const harness = createHarness();
    const configured = resolveUnpackedExtension(fixture);
    const page = attachExtensionCapabilities(harness.host, [configured]);

    await expect(page.extension.sidePanel.current({
      pagePath: "?tab=7",
    })).rejects.toThrow("page path must not be empty");

    const pageWithoutDeclaration = attachExtensionCapabilities(
      { raw: harness.host.raw } as InstrumentedPage,
      [{
        ...configured,
        manifest: { ...configured.manifest, side_panel: undefined },
      }],
    );
    await expect(
      pageWithoutDeclaration.extension.sidePanel.current(),
    ).rejects.toThrow("does not declare side_panel.default_path");
  });

  it("treats closing an already-closed handle as an idempotent no-op", async () => {
    const harness = createHarness();
    const page = attachExtensionCapabilities(harness.host, [
      resolveUnpackedExtension(fixture),
    ]);
    const handle = await page.extension.sidePanel.open({
      timeout: 500,
      interval: 1,
    });

    await handle.close({ timeout: 500, interval: 1 });
    await expect(handle.close()).resolves.toBeUndefined();
    expect(harness.workerEvaluate).toHaveBeenCalledOnce();
  });

  it("keeps handle close idempotent before Puppeteer flips page.isClosed()", async () => {
    const harness = createHarness({ markPageClosedOnClose: false });
    const page = attachExtensionCapabilities(harness.host, [
      resolveUnpackedExtension(fixture),
    ]);
    const handle = await page.extension.sidePanel.open({
      timeout: 500,
      interval: 1,
    });

    await handle.close({ timeout: 500, interval: 1 });
    expect(handle.page.isClosed()).toBe(false);
    await handle.close();
    expect(harness.workerEvaluate).toHaveBeenCalledOnce();
  });

  it("shares one close operation across concurrent callers", async () => {
    const harness = createHarness();
    const page = attachExtensionCapabilities(harness.host, [
      resolveUnpackedExtension(fixture),
    ]);
    const handle = await page.extension.sidePanel.open({
      timeout: 500,
      interval: 1,
    });

    await Promise.all([
      handle.close({ timeout: 500, interval: 1 }),
      handle.close({ timeout: 500, interval: 1 }),
    ]);
    expect(harness.workerEvaluate).toHaveBeenCalledOnce();
  });

  it("fails quickly with a targeted error when the worker is not observable", async () => {
    const harness = createHarness();
    const page = attachExtensionCapabilities(harness.host, [
      resolveUnpackedExtension(fixture),
    ]);
    const handle = await page.extension.sidePanel.open({
      timeout: 500,
      interval: 1,
    });
    const waitForTarget = vi.fn(async (
      _predicate: (target: Target) => boolean,
      _options: { timeout?: number },
    ) => {
      throw new Error("Puppeteer target timeout");
    });
    Object.assign(harness.browser, {
      targets: () => [],
      waitForTarget,
    });

    await expect(handle.close({ timeout: 0 })).rejects.toThrow(
      "Could not resolve the service worker",
    );
    expect(waitForTarget).toHaveBeenCalledOnce();
    expect(waitForTarget.mock.calls[0]?.[1]).toEqual({ timeout: 1 });
  });
});
