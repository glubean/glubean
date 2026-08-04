import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Extension, Page } from "puppeteer-core";
import type {
  BrowserOptions,
  BrowserTestContext,
  InstrumentedPage,
} from "../page.js";
import { GlubeanBrowser } from "../page.js";
import {
  closeExtensionSidePanel,
  getInstalledExtension,
  waitForExtensionOwnedPage,
  waitForExtensionPageClosed,
  type InstalledExtensionSelector,
  type InstalledExtensionWaitOptions,
} from "./actions.js";
import {
  resolveExtensionPagePath,
  type UnpackedExtension,
} from "./manifest.js";
import { parseExtensionUrl, waitForExtensionWorker } from "./targets.js";

export interface ExtensionSidePanelTargetOptions
  extends InstalledExtensionWaitOptions {
  /** Select a loaded extension. Required when more than one extension is loaded. */
  extension?: string | InstalledExtensionSelector;
  /** Override the manifest-declared `side_panel.default_path`. */
  pagePath?: string;
  /**
   * Total discovery/lifecycle timeout in milliseconds. Defaults to 10 seconds;
   * 0 probes once without waiting.
   */
  timeout?: number;
  /** Polling interval in milliseconds. Defaults to 50. */
  interval?: number;
}

export type OpenExtensionSidePanelOptions = ExtensionSidePanelTargetOptions;

export interface CloseExtensionSidePanelOptions
  extends InstalledExtensionWaitOptions {
  /** Chrome window containing the side panel. Required for multi-window tests. */
  windowId?: number;
  /**
   * Total worker-discovery and close-wait timeout. Defaults to 10 seconds;
   * 0 probes once without waiting.
   */
  timeout?: number;
  /** Polling interval in milliseconds. Defaults to 50. */
  interval?: number;
}

/** A native side panel together with the state needed to close that exact page. */
export interface ExtensionSidePanelHandle {
  /** Raw Puppeteer page for the extension-owned side-panel document. */
  readonly page: Page;
  readonly extensionId: string;
  readonly path: string;
  /**
   * Close the native side panel and wait until this page is no longer active.
   * Concurrent calls share the first in-flight close operation and its options.
   */
  close(options?: CloseExtensionSidePanelOptions): Promise<void>;
}

export interface ExtensionSidePanelController {
  /** Trigger the real toolbar action and wait for the side-panel document. */
  open(options?: OpenExtensionSidePanelOptions): Promise<ExtensionSidePanelHandle>;
  /** Return the matching active side panel without triggering the toolbar action. */
  current(
    options?: ExtensionSidePanelTargetOptions,
  ): Promise<ExtensionSidePanelHandle | null>;
}

export interface ExtensionController {
  readonly sidePanel: ExtensionSidePanelController;
}

/**
 * An instrumented host page created by a browser that loaded unpacked Chrome
 * extensions. Extension-only behavior is scoped under `page.extension` rather
 * than added to the generic `InstrumentedPage` surface.
 */
export type ExtensionPage = InstrumentedPage & {
  readonly extension: ExtensionController;
};

/** Browser client whose pages carry extension-scoped capabilities. */
export class ExtensionBrowser extends GlubeanBrowser {
  private readonly _getExtensions: () => readonly UnpackedExtension[];

  /** @internal Created by the `browser({ extensions })` client factory. */
  constructor(
    getBrowser: () => Promise<Browser>,
    baseUrl: string | undefined,
    options: BrowserOptions,
    getExtensions: () => readonly UnpackedExtension[],
  ) {
    super(getBrowser, baseUrl, options);
    this._getExtensions = getExtensions;
  }

  override async newPage(ctx: BrowserTestContext): Promise<ExtensionPage> {
    const page = await super.newPage(ctx);
    return attachExtensionCapabilities(page, this._getExtensions(), this);
  }
}

/** @internal Attach extension capabilities to one SDK-created page instance. */
export function attachExtensionCapabilities(
  page: InstrumentedPage,
  configuredExtensions: readonly UnpackedExtension[],
  owner?: GlubeanBrowser,
): ExtensionPage {
  if (Object.prototype.hasOwnProperty.call(page, "extension")) {
    throw new Error("Chrome extension capabilities are already attached to this page.");
  }
  const extension = createExtensionController(page, configuredExtensions, owner);
  Object.defineProperty(page, "extension", {
    configurable: false,
    enumerable: false,
    value: extension,
    writable: false,
  });
  return page as ExtensionPage;
}

function createExtensionController(
  hostPage: InstrumentedPage,
  configuredExtensions: readonly UnpackedExtension[],
  owner: GlubeanBrowser | undefined,
): ExtensionController {
  const createHandle = (
    extension: Extension,
    page: Page,
    path: string,
  ): ExtensionSidePanelHandle => {
    owner?._track(page);
    let closed = page.isClosed();
    let closing: Promise<void> | undefined;
    return {
      page,
      extensionId: extension.id,
      path,
      async close(options = {}): Promise<void> {
        if (closed || page.isClosed()) {
          closed = true;
          return;
        }
        if (closing) return closing;

        const budget = createTimeoutBudget(options.timeout);
        closing = (async () => {
          const workerTimeout = budget.remaining();
          let worker: Awaited<ReturnType<typeof waitForExtensionWorker>>;
          try {
            worker = await waitForExtensionWorker(
              hostPage.raw.browser(),
              extension.id,
              // Puppeteer treats timeout: 0 as "wait forever". Keep zero as
              // an immediate probe by allowing at most a 1ms target wait.
              { timeout: Math.max(1, workerTimeout) },
            );
          } catch (error) {
            throw extensionWorkerTimeoutError(extension.id, workerTimeout, error);
          }
          await closeExtensionSidePanel(worker.worker, {
            windowId: options.windowId,
          });
          await waitForExtensionPageClosed(extension, page, {
            timeout: budget.remaining(),
            interval: options.interval,
          });
          closed = true;
        })();
        try {
          await closing;
        } catch (error) {
          closing = undefined;
          throw error;
        }
      },
    };
  };

  const resolvePath = (
    extension: Extension,
    requestedPath: string | undefined,
  ): string => {
    if (requestedPath !== undefined) return normalizePagePath(requestedPath);
    const configured = configuredExtensions.find(
      (candidate) => canonicalPath(candidate.path) === canonicalPath(extension.path),
    );
    if (!configured) {
      throw new Error(
        `Loaded Chrome extension ${extension.id} is not one of the configured unpacked extensions; ` +
          `pass "pagePath" explicitly.`,
      );
    }
    return normalizePagePath(resolveExtensionPagePath(configured, "sidepanel"));
  };

  const findCurrent = async (
    extension: Extension,
    path: string,
  ): Promise<Page | null> => {
    const matches = (await extension.pages()).filter((candidate) => {
      if (candidate.isClosed()) return false;
      try {
        const parsed = parseExtensionUrl(candidate.url());
        return parsed?.id === extension.id && parsed.path === path;
      } catch {
        return false;
      }
    });
    if (matches.length > 1) {
      throw new Error(
        `Multiple active side-panel pages matched extension ${extension.id} and path ${path}; ` +
          `use the low-level extension target helpers to select a specific window.`,
      );
    }
    return matches[0] ?? null;
  };

  return {
    sidePanel: {
      async open(options = {}): Promise<ExtensionSidePanelHandle> {
        const budget = createTimeoutBudget(options.timeout);
        const extension = await getInstalledExtension(
          hostPage.raw.browser(),
          options.extension,
          { timeout: budget.remaining(), interval: options.interval },
        );
        const path = resolvePath(extension, options.pagePath);
        if (await findCurrent(extension, path)) {
          throw new Error(
            `Chrome side panel is already open for extension ${extension.id} and path ${path}; ` +
              `use sidePanel.current() or close the existing handle before calling open().`,
          );
        }
        if (typeof extension.triggerAction !== "function") {
          throw new Error(
            "This Puppeteer runtime does not expose Extension.triggerAction(); use puppeteer-core >= 24.41.0.",
          );
        }
        await extension.triggerAction(hostPage.raw);
        await waitForExtensionOwnedPage(extension, path, {
          timeout: budget.remaining(),
          interval: options.interval,
        });
        // Re-scan after the availability wait so a closed race is rejected and
        // multiple same-path panels fail explicitly instead of picking one.
        const page = await findCurrent(extension, path);
        if (!page) {
          throw new Error(
            `Chrome side-panel page disappeared after opening: ${path}`,
          );
        }
        return createHandle(extension, page, path);
      },

      async current(options = {}): Promise<ExtensionSidePanelHandle | null> {
        const extension = await getInstalledExtension(
          hostPage.raw.browser(),
          options.extension,
          { timeout: options.timeout, interval: options.interval },
        );
        const path = resolvePath(extension, options.pagePath);
        const page = await findCurrent(extension, path);
        return page ? createHandle(extension, page, path) : null;
      },
    },
  };
}

function createTimeoutBudget(requestedTimeout: number | undefined): {
  remaining(): number;
} {
  const timeout = Math.max(0, requestedTimeout ?? 10_000);
  const deadline = Date.now() + timeout;
  return {
    remaining: () => Math.max(0, deadline - Date.now()),
  };
}

function extensionWorkerTimeoutError(
  extensionId: string,
  timeout: number,
  cause?: unknown,
): Error {
  return new Error(
    `Could not resolve the service worker for Chrome extension ${extensionId} within ${timeout}ms; ` +
      "ensure the extension background worker can activate before closing the Side Panel.",
    cause === undefined ? undefined : { cause },
  );
}

function normalizePagePath(path: string): string {
  if (!path.trim()) {
    throw new Error("Chrome extension side-panel page path must not be empty.");
  }
  const normalized = path.replace(/^\/+/, "").split(/[?#]/, 1)[0]!;
  if (!normalized) {
    throw new Error("Chrome extension side-panel page path must not be empty.");
  }
  try {
    return decodeURIComponent(normalized);
  } catch {
    return normalized;
  }
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
