import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Extension, Page, Target, WebWorker } from "puppeteer-core";
import { describe, expect, it, vi } from "vitest";
import {
  closeExtensionSidePanel,
  getInstalledExtension,
  triggerExtensionAction,
  waitForExtensionOwnedPage,
  waitForExtensionPageClosed,
} from "./actions.js";

const fixture = fileURLToPath(new URL("./fixtures/extension", import.meta.url));

function fakeExtension(overrides: Partial<Extension> = {}): Extension {
  return {
    id: "abc123",
    name: "Fixture Extension",
    version: "1.0.0",
    path: "/tmp/fixture-extension",
    enabled: true,
    pages: async () => [],
    workers: async () => [],
    triggerAction: async () => {},
    ...overrides,
  } as Extension;
}

function fakeBrowser(extensions: Extension[]): Browser {
  return {
    extensions: async () => new Map(extensions.map((extension) => [extension.id, extension])),
  } as unknown as Browser;
}

describe("installed extension actions", () => {
  it("selects a loaded extension by id, name, or path", async () => {
    const extension = fakeExtension();
    const browser = fakeBrowser([extension]);

    expect(await getInstalledExtension(browser)).toBe(extension);
    expect(await getInstalledExtension(browser, "abc123")).toBe(extension);
    expect(await getInstalledExtension(browser, { name: "Fixture Extension" })).toBe(extension);
    expect(await getInstalledExtension(browser, { path: "/tmp/fixture-extension" })).toBe(extension);
  });

  it("waits for Chrome to finish registering an unpacked extension", async () => {
    const extension = fakeExtension();
    let calls = 0;
    const browser = {
      extensions: async () => new Map(
        calls++ === 0 ? [] : [[extension.id, extension]],
      ),
    } as unknown as Browser;

    expect(await getInstalledExtension(browser, undefined, {
      timeout: 500,
      interval: 1,
    })).toBe(extension);
    expect(calls).toBe(2);
  });

  it("triggers the toolbar action on the selected page", async () => {
    const triggerAction = vi.fn(async () => {});
    const extension = fakeExtension({ triggerAction });
    const browser = fakeBrowser([extension]);
    const page = { browser: () => browser } as unknown as Page;

    expect(await triggerExtensionAction(page)).toBe(extension);
    expect(triggerAction).toHaveBeenCalledWith(page);
  });

  it("requires a selector when more than one extension is loaded", async () => {
    const browser = fakeBrowser([
      fakeExtension(),
      fakeExtension({ id: "def456", name: "Second Extension" }),
    ]);

    await expect(getInstalledExtension(browser)).rejects.toThrow(
      "2 Chrome extensions are loaded",
    );
    await expect(getInstalledExtension(browser, {})).rejects.toThrow(
      "2 Chrome extensions are loaded",
    );
  });

  it("rejects an empty string selector immediately", async () => {
    await expect(getInstalledExtension(fakeBrowser([]), "")).rejects.toThrow(
      "id must not be empty",
    );
  });

  it("matches an extension path through a filesystem symlink", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "glubean-extension-path-"));
    const linkedPath = join(tempDirectory, "extension-link");
    symlinkSync(fixture, linkedPath, process.platform === "win32" ? "junction" : "dir");
    try {
      const extension = fakeExtension({ path: fixture });
      await expect(getInstalledExtension(
        fakeBrowser([extension]),
        { path: linkedPath },
        { timeout: 0 },
      )).resolves.toBe(extension);
    } finally {
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  it("waits for an owned page to open and close", async () => {
    const target = {} as Target;
    const page = {
      url: () => "chrome-extension://abc123/sidepanel.html?tab=7#/home",
      isClosed: () => false,
      target: () => target,
    } as Page;
    let calls = 0;
    const extension = fakeExtension({
      pages: async () => calls++ === 0 ? [] : calls < 3 ? [page] : [],
    });

    expect(await waitForExtensionOwnedPage(extension, "/sidepanel.html", {
      timeout: 500,
      interval: 1,
    })).toBe(page);
    await expect(waitForExtensionPageClosed(extension, page, {
      timeout: 500,
      interval: 1,
    })).resolves.toBeUndefined();
  });

  it("closes the native side panel through the extension worker", async () => {
    const evaluate = vi.fn(async () => {});
    const worker = { evaluate } as unknown as WebWorker;

    await closeExtensionSidePanel(worker, { windowId: 7 });

    expect(evaluate).toHaveBeenCalledOnce();
    expect(evaluate.mock.calls[0]?.[1]).toBe(7);
  });

  it("treats an already-closed extension page as successfully closed", async () => {
    const pages = vi.fn(async () => []);
    const extension = fakeExtension({ pages });
    const page = {
      isClosed: () => true,
      url: () => { throw new Error("target gone"); },
    } as unknown as Page;

    await expect(waitForExtensionPageClosed(extension, page)).resolves.toBeUndefined();
    expect(pages).not.toHaveBeenCalled();
  });

  it("does not confuse a different Page wrapper for a closed target", async () => {
    const target = {} as Target;
    const original = {
      isClosed: () => false,
      url: () => "chrome-extension://abc123/sidepanel.html",
      target: () => target,
    } as Page;
    const secondWrapper = {
      isClosed: () => false,
      url: () => "chrome-extension://abc123/sidepanel.html",
      target: () => target,
    } as Page;
    const extension = fakeExtension({ pages: async () => [secondWrapper] });

    await expect(waitForExtensionPageClosed(extension, original, {
      timeout: 5,
      interval: 1,
    })).rejects.toThrow("Timed out");
  });

  it("forwards discovery wait options through triggerExtensionAction", async () => {
    const page = { browser: () => fakeBrowser([]) } as unknown as Page;

    await expect(triggerExtensionAction(page, undefined, { timeout: 0 })).rejects.toThrow(
      "within 0ms",
    );
  });
});
