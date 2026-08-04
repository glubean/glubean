import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Extension, Page, WebWorker } from "puppeteer-core";

export interface InstalledExtensionSelector {
  id?: string;
  name?: string;
  path?: string;
}

export interface InstalledExtensionWaitOptions {
  timeout?: number;
  interval?: number;
}

/** Return a loaded Puppeteer Extension, with clear ambiguity/not-found errors. */
export async function getInstalledExtension(
  browser: Browser,
  selector?: string | InstalledExtensionSelector,
  options: InstalledExtensionWaitOptions = {},
): Promise<Extension> {
  if (typeof selector === "string" && selector.trim() === "") {
    throw new Error("Chrome extension id must not be empty.");
  }
  const extensionsMethod = (browser as Browser & {
    extensions?: () => Promise<Map<string, Extension>>;
  }).extensions;
  if (typeof extensionsMethod !== "function") {
    throw new Error(
      "This Puppeteer runtime does not expose browser.extensions(); use puppeteer-core >= 24.41.0.",
    );
  }

  const normalized = typeof selector === "string" ? { id: selector } : selector;
  const effectiveSelector = normalized && Object.values(normalized).some(
    (value) => value !== undefined,
  ) ? normalized : undefined;
  const timeout = options.timeout ?? 10_000;
  const interval = options.interval ?? 50;
  const deadline = Date.now() + timeout;
  let loadedCount = 0;

  do {
    const extensions = [...(await extensionsMethod.call(browser)).values()];
    loadedCount = extensions.length;
    const matches = effectiveSelector
      ? extensions.filter((extension) => matchesExtension(extension, effectiveSelector))
      : extensions;

    if (matches.length === 1) return matches[0]!;
    if (!effectiveSelector && extensions.length > 1) {
      throw new Error(
        `${extensions.length} Chrome extensions are loaded; select one by id, name, or path.`,
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `Multiple loaded Chrome extensions matched ${JSON.stringify(effectiveSelector)}; select one by id, name, or path.`,
      );
    }
    if (Date.now() >= deadline) break;
    await delay(interval);
  } while (true);

  if (!effectiveSelector && loadedCount === 0) {
    throw new Error(`No Chrome extensions loaded within ${timeout}ms.`);
  }
  throw new Error(
    `No loaded Chrome extension matched ${JSON.stringify(effectiveSelector)} within ${timeout}ms.`,
  );
}

/** Simulate the extension toolbar action for a real browser page. */
export async function triggerExtensionAction(
  page: Page,
  selector?: string | InstalledExtensionSelector,
  options: InstalledExtensionWaitOptions = {},
): Promise<Extension> {
  const extension = await getInstalledExtension(page.browser(), selector, options);
  if (typeof extension.triggerAction !== "function") {
    throw new Error(
      "This Puppeteer runtime does not expose Extension.triggerAction(); use puppeteer-core >= 24.41.0.",
    );
  }
  await extension.triggerAction(page);
  return extension;
}

/** Wait until an active extension-owned page matches a manifest-relative path. */
export async function waitForExtensionOwnedPage(
  extension: Extension,
  path: string,
  options: { timeout?: number; interval?: number } = {},
): Promise<Page> {
  const normalizedPath = decodePath(path.replace(/^\/+/, "").split(/[?#]/, 1)[0]!);
  const timeout = options.timeout ?? 10_000;
  const interval = options.interval ?? 50;
  const deadline = Date.now() + timeout;

  while (Date.now() <= deadline) {
    const page = (await extension.pages()).find(
      (candidate) => safeExtensionPagePath(candidate) === normalizedPath,
    );
    if (page) return page;
    await delay(interval);
  }
  throw new Error(
    `Timed out after ${timeout}ms waiting for extension page: ${normalizedPath}`,
  );
}

/** Wait until an extension-owned page is no longer active. */
export async function waitForExtensionPageClosed(
  extension: Extension,
  page: Page,
  options: { timeout?: number; interval?: number } = {},
): Promise<void> {
  if (page.isClosed()) return;
  let url: string;
  try {
    url = page.url();
  } catch {
    return;
  }
  const path = extensionPath(url);
  if (path === undefined) {
    throw new Error(`Page is not owned by a Chrome extension: ${url}`);
  }
  const timeout = options.timeout ?? 10_000;
  const interval = options.interval ?? 50;
  const deadline = Date.now() + timeout;
  const target = page.target();

  while (Date.now() <= deadline) {
    const stillOpen = !page.isClosed() && (await extension.pages()).some(
      (candidate) => candidate === page || candidate.target() === target,
    );
    if (!stillOpen) return;
    await delay(interval);
  }
  throw new Error(
    `Timed out after ${timeout}ms waiting for extension page to close: ${path}`,
  );
}

/**
 * Close the native Chrome side panel from an extension service worker.
 * `chrome.sidePanel.close()` is available in Chrome 141 and newer.
 */
export async function closeExtensionSidePanel(
  worker: WebWorker,
  options: { windowId?: number } = {},
): Promise<void> {
  await worker.evaluate(async (requestedWindowId: number | undefined) => {
    type ChromeApi = {
      sidePanel?: { close?: (options: { windowId: number }) => Promise<void> };
      tabs?: {
        query?: (queryInfo: { active: boolean; currentWindow: boolean }) => Promise<Array<{
          windowId?: number;
        }>>;
      };
    };
    const chromeApi = (globalThis as unknown as { chrome?: ChromeApi }).chrome;
    if (typeof chromeApi?.sidePanel?.close !== "function") {
      throw new Error(
        "chrome.sidePanel.close() is unavailable; native side-panel closing requires Chrome 141 or newer.",
      );
    }

    let windowId = requestedWindowId;
    if (windowId === undefined) {
      const tabs = await chromeApi.tabs?.query?.({ active: true, currentWindow: true });
      windowId = tabs?.[0]?.windowId;
    }
    if (windowId === undefined) {
      throw new Error("Could not resolve the Chrome window containing the side panel.");
    }
    await chromeApi.sidePanel.close({ windowId });
  }, options.windowId);
}

function matchesExtension(
  extension: Extension,
  selector: InstalledExtensionSelector,
): boolean {
  return (
    (selector.id === undefined || extension.id === selector.id) &&
    (selector.name === undefined || extension.name === selector.name) &&
    (selector.path === undefined || canonicalPath(extension.path) === canonicalPath(selector.path))
  );
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function extensionPath(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "chrome-extension:") return undefined;
    return decodePath(parsed.pathname.replace(/^\/+/, ""));
  } catch {
    return undefined;
  }
}

function safeExtensionPagePath(page: Page): string | undefined {
  try {
    return extensionPath(page.url());
  } catch {
    return undefined;
  }
}

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
