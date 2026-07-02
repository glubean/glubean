/**
 * GlubeanBrowser and GlubeanPage — browser automation wrappers that integrate
 * with the Glubean test context.
 *
 * `GlubeanBrowser` manages the Chrome connection (returned by the plugin factory).
 * `GlubeanPage` wraps a single Puppeteer Page with auto-instrumentation:
 * - `ctx.trace()` for every `goto()` navigation
 * - `ctx.metric()` for page load and DOMContentLoaded timing
 * - `ctx.log()` / `ctx.warn()` for browser console output and uncaught errors
 * - `ctx.trace()` for in-page network requests (XHR, fetch) via CDP
 *
 * @module page
 */

import type {
  Browser,
  Dialog,
  ElementHandle,
  HTTPRequest,
  HTTPResponse,
  Page,
} from "puppeteer-core";
import {
  EvidenceSession,
  type DownloadEntry,
  type EmulationOptions,
  type MockRule,
  type ScreenshotMode,
  type ScreenshotTrigger,
  type StorageState,
} from "./evidence.js";
import { collectNavigationMetrics } from "./metrics.js";
import { createWrappedLocator, type WrappedLocator } from "./locator.js";
import { createFrame, type GlubeanFrame } from "./frame.js";
import { getRuntime } from "@glubean/sdk/internal";

/**
 * A GlubeanPage that also exposes every Puppeteer `Page` method/property
 * via Proxy fallthrough. GlubeanPage's own methods take priority; anything
 * else is forwarded to the underlying `raw` Page.
 */
export type InstrumentedPage = GlubeanPage & Page;

/** Per-action options for interaction methods. */
export interface ActionOptions {
  /** Timeout in ms (overrides the global `actionTimeout`). */
  timeout?: number;
}

/**
 * Structural type for a puppeteer-compatible module.
 *
 * Accepts `puppeteer-core` (default), `puppeteer`, or `puppeteer-extra` with
 * plugins pre-registered. Pass via the `puppeteer` option in `BrowserOptions`
 * to use puppeteer-extra plugins (Stealth, Recaptcha, Adblocker, etc.).
 */
export interface PuppeteerLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  launch(options?: any): Promise<Browser>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  connect(options?: any): Promise<Browser>;
}

/**
 * Plugin configuration options.
 *
 * Use **one** of these connection modes:
 * - `launch: true` — auto-detect and launch local Chrome in headless mode
 * - `endpoint: "CHROME_ENDPOINT"` — var key resolving to a `ws://`, `http://`, or `https://` URL
 *
 * When `endpoint` resolves to `http://` / `https://`, the plugin auto-discovers
 * the WebSocket debugger URL via Chrome's `/json/version` endpoint.
 */
export type BrowserOptions =
  & BrowserOptionsBase
  & (
    | { launch: true; executablePath?: string; endpoint?: never }
    | { endpoint: string; launch?: never; executablePath?: never }
  );

/** Network trace filter configuration. */
export interface NetworkTraceOptions {
  /**
   * Content-type prefixes to include. Requests whose `content-type` response
   * header starts with any of these prefixes are traced; the rest are skipped.
   *
   * Ignored when `filter` is provided.
   *
   * @default ["application/json", "text/html"]
   */
  include?: string[];
  /**
   * URL paths to exclude. Pass `[]` to keep everything.
   * Ignored when `filter` is provided.
   *
   * @default ["/favicon.ico", "/favicon.png", "/apple-touch-icon.png", "/apple-touch-icon-precomposed.png"]
   */
  excludePaths?: string[];
  /**
   * Custom predicate. When provided, overrides `include` and `excludePaths`.
   * Return `true` to trace the request, `false` to skip.
   */
  filter?: (req: { url: string; contentType: string; status: number }) => boolean;
}

/** Checks to apply in `expectResponse()`. */
export interface ResponseChecks {
  /** Expected status code, or a predicate. */
  status?: number | ((s: number) => boolean);
  /** Assert that response headers contain the given substrings. */
  headerContains?: Record<string, string>;
}

/**
 * How an unhandled native dialog (`alert`/`confirm`/`prompt`/`beforeunload`)
 * is auto-resolved when no {@link GlubeanPage.onDialog} handler is registered.
 * @default "dismiss"
 */
export type DialogMode = "accept" | "dismiss";

/** A handler registered via {@link GlubeanPage.onDialog}. Must resolve the dialog. */
export type DialogHandler = (dialog: Dialog) => void | Promise<void>;

interface BrowserOptionsBase {
  /**
   * Custom puppeteer-compatible instance (e.g. `puppeteer-extra` with plugins).
   *
   * When provided, Glubean uses this instance for `launch()` / `connect()`
   * instead of the default `puppeteer-core` import. All puppeteer-extra plugins
   * registered on the instance will be active on every page.
   *
   * @example
   * ```ts
   * import puppeteerExtra from "puppeteer-extra";
   * import StealthPlugin from "puppeteer-extra-plugin-stealth";
   * puppeteerExtra.use(StealthPlugin());
   *
   * browser({ launch: true, puppeteer: puppeteerExtra })
   * ```
   */
  puppeteer?: PuppeteerLike;
  /**
   * Optional var key whose runtime value is prepended to relative URLs in `goto()`.
   * @example "APP_URL"
   */
  baseUrl?: string;
  /**
   * Network request tracing.
   *
   * - `true` — trace with default filter (document + JSON only)
   * - `false` — disable network tracing
   * - `object` — custom filter configuration
   *
   * Default: `true`.
   */
  networkTrace?: boolean | NetworkTraceOptions;
  /**
   * Request mocking. Matching requests are fulfilled with a canned response on
   * the shared evidence CDP session (via the CDP `Fetch` domain); everything
   * else passes through untouched and is still network-traced.
   *
   * When set, Glubean owns request interception on the page. **Do not also call
   * `page.setRequestInterception(true)`** — it conflicts with the mock handler
   * and Glubean throws a clear error if you try. Leave `mock` unset to manage
   * interception yourself.
   *
   * @example
   * ```ts
   * browser({
   *   launch: true,
   *   mock: [
   *     { url: "/api/user", body: { id: 1, name: "Ada" } },
   *     { url: /\/api\/flaky/, status: 500, body: "boom" },
   *   ],
   * })
   * ```
   */
  mock?: MockRule[];
  /**
   * Environment emulation applied on the shared evidence CDP session (via the
   * CDP `Emulation` domain): `timezone`, `geolocation`, and `viewport`.
   *
   * When `emulate.viewport` is set, **Glubean is the sole viewport owner** — do
   * **not** also call `page.setViewport()`. Both drive device metrics and clobber
   * each other last-wins, so Glubean applies the viewport last and throws a clear
   * error if `page.setViewport()` is called.
   *
   * @example
   * ```ts
   * browser({
   *   launch: true,
   *   emulate: {
   *     timezone: "America/New_York",
   *     geolocation: { latitude: 40.71, longitude: -74.0 },
   *     viewport: { width: 390, height: 844, mobile: true },
   *   },
   * })
   * ```
   */
  emulate?: EmulationOptions;
  /**
   * Cookies / localStorage to restore before the page's first script runs —
   * a thin "login once, reuse the session" primitive. Capture the current
   * state with `page.getStorageState()`.
   *
   * @example
   * ```ts
   * const state = await loggedInPage.getStorageState();
   * const chrome2 = browser({ launch: true, storageState: state });
   * ```
   */
  storageState?: StorageState;
  /**
   * How an unhandled native dialog (`alert`/`confirm`/`prompt`/`beforeunload`)
   * is auto-resolved. Every dialog (handled or not) emits a `browser:dialog`
   * evidence event first. Override per-dialog with `page.onDialog(handler)`.
   * @default "dismiss"
   */
  dialogMode?: DialogMode;
  /** Emit `ctx.metric()` for navigation timing. Default: true. */
  metrics?: boolean;
  /** Forward browser console output to `ctx.log()`/`ctx.warn()`. Default: true. */
  consoleForward?: boolean;
  /**
   * Auto-screenshot behavior.
   * - `"off"` — no automatic screenshots
   * - `"on-failure"` — capture a screenshot when a step or test fails (default)
   * - `"every-step"` — capture after every goto/click/type AND on failure
   */
  screenshot?: ScreenshotMode;
  /** Directory for auto-screenshots. Default: `".glubean/screenshots"`. */
  screenshotDir?: string;
  /**
   * Directory downloads are saved to. Default: `".glubean/downloads"`.
   * Downloads are always captured as evidence (like dialogs/popups) — this
   * only controls where the files land, not whether capture is on.
   */
  downloadDir?: string;
  /** Default timeout (ms) for Locator auto-waiting on `click()`/`type()` etc. Default: 30 000. */
  actionTimeout?: number;
  /**
   * Extra options forwarded to `puppeteer.launch()`.
   *
   * Merged with Glubean defaults (`headless: true`, `--no-sandbox`, etc.).
   * Your values take priority over defaults.
   *
   * @example
   * ```ts
   * browser({
   *   launch: true,
   *   launchOptions: { headless: false, slowMo: 100, devtools: true },
   * })
   * ```
   */
  launchOptions?: Record<string, unknown>;
}

/**
 * Structured interaction record emitted by browser methods.
 *
 * Matches the `GlubeanAction` shape from `@glubean/sdk` via structural typing.
 */
export interface BrowserAction {
  category: string;
  target: string;
  duration: number;
  status: "ok" | "error" | "timeout";
  detail?: Record<string, unknown>;
}

/**
 * Structured event emitted for observations/artifacts (screenshots, console errors).
 *
 * Matches the `GlubeanEvent` shape from `@glubean/sdk` via structural typing.
 */
export interface BrowserEvent {
  type: string;
  data: Record<string, unknown>;
}

/**
 * Minimal subset of TestContext needed by the browser plugin.
 *
 * Defined here to avoid a hard import dependency on the SDK's internal types,
 * keeping the plugin compatible across SDK versions via structural typing.
 */
export interface BrowserTestContext {
  /** Test identifier used for namespacing screenshots. */
  testId?: string;
  action(a: BrowserAction): void;
  event(ev: BrowserEvent): void;
  trace(request: {
    name?: string;
    method: string;
    url: string;
    status: number;
    duration: number;
  }): void;
  metric(
    name: string,
    value: number,
    options?: { unit?: string; tags?: Record<string, string> },
  ): void;
  log(message: string, data?: unknown): void;
  warn(condition: boolean, message: string): void;
  /** Save an artifact file. Optional — present when SDK >= 0.13.0. */
  saveArtifact?(
    name: string,
    content: string | Uint8Array,
    options?: { type?: string; mimeType?: string },
  ): Promise<string>;
  /** Directory where artifacts are stored. Optional — present when SDK >= 0.13.0. */
  readonly artifactDir?: string;
}

// ── Module-level helpers (used by the shoot callback in _create) ──────

/** Sanitize a string into a safe filename segment. */
function _sanitizeFilename(s: string): string {
  return s.replace(/[^a-z0-9_-]/gi, "_").slice(0, 60);
}

/** Create a directory (and any parents) if it does not already exist. */
async function _ensureDir(dir: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
}

/**
 * Connected browser instance returned by the plugin.
 *
 * Call `newPage(ctx)` to create an instrumented page wired to the test context.
 *
 * @example
 * ```ts
 * const pg = await chrome.newPage(ctx);
 * await pg.goto("/dashboard");
 * await pg.close();
 * ```
 */
export class GlubeanBrowser {
  private readonly _getBrowser: () => Promise<Browser>;
  private readonly _baseUrl: string | undefined;
  private readonly _options: BrowserOptions;
  private _openPages = 0;
  private _closeTimer: ReturnType<typeof setTimeout> | null = null;

  /** @internal — created by the plugin factory. */
  constructor(
    getBrowser: () => Promise<Browser>,
    baseUrl: string | undefined,
    options: BrowserOptions,
  ) {
    this._getBrowser = getBrowser;
    this._baseUrl = baseUrl;
    this._options = options;
  }

  /**
   * Create a new instrumented page wired to the given test context.
   *
   * Each call creates a fresh browser page. Remember to call `page.close()`
   * in your teardown (or use `test.extend()` with a lifecycle factory).
   */
  async newPage(ctx: BrowserTestContext): Promise<InstrumentedPage> {
    if (this._closeTimer) {
      clearTimeout(this._closeTimer);
      this._closeTimer = null;
    }
    const browser = await this._getBrowser();

    // Reuse the default about:blank tab instead of opening a new one.
    // When Chrome launches it always creates one blank page — reusing it
    // avoids the extra empty tab that lingers in headless: false mode.
    const pages = await browser.pages();
    const blank = pages.find((p) => {
      const url = p.url();
      return url === "about:blank" || url === "chrome://new-tab-page/";
    });
    const rawPage = blank ?? await browser.newPage();

    this._track(rawPage);

    // Read testId lazily from the runtime carrier — the harness updates it
    // before each test runs, so reading at newPage() time is always fresh.
    const runtimeTestId = getRuntime()?.test?.id as string | undefined;
    return GlubeanPage._create(
      rawPage,
      this._baseUrl,
      ctx,
      this._options,
      runtimeTestId,
      this,
    );
  }

  /**
   * @internal Register a raw page in the open-page accounting so the browser
   * isn't auto-closed while it's alive. Cancels any pending close, increments
   * the counter, and decrements (rescheduling close at zero) on page close.
   * Used by both `newPage()` and `GlubeanPage.waitForPopup()` (popups are
   * real pages that must keep the browser open too).
   */
  _track(rawPage: Page): void {
    if (this._closeTimer) {
      clearTimeout(this._closeTimer);
      this._closeTimer = null;
    }
    this._openPages++;
    rawPage.once("close", () => {
      this._openPages--;
      if (this._openPages <= 0) {
        this._scheduleClose();
      }
    });
  }

  private _scheduleClose(): void {
    this._closeTimer = setTimeout(async () => {
      if (this._openPages <= 0) {
        try { await this.close(); } catch { /* already closed */ }
      }
    }, 3000);
    // Don't let the timer keep the process alive
    if (this._closeTimer && typeof this._closeTimer === "object" && "unref" in this._closeTimer) {
      (this._closeTimer as NodeJS.Timeout).unref();
    }
  }

  /** Disconnect from the browser without closing it. Useful for remote Chrome. */
  async disconnect(): Promise<void> {
    const browser = await this._getBrowser();
    browser.disconnect();
  }

  /** Close the browser and terminate the Chrome process. */
  async close(): Promise<void> {
    const browser = await this._getBrowser();
    await browser.close();
  }
}

/**
 * Instrumented browser page with auto-tracing, metrics, and console forwarding.
 *
 * Wraps a subset of Puppeteer's Page API. For advanced operations, use `.raw`.
 *
 * @example
 * ```ts
 * await page.goto("/login");
 * await page.type("#email", "user@test.com");
 * await page.click('button[type="submit"]');
 * const title = await page.title();
 * ```
 */
export class GlubeanPage {
  /** The underlying Puppeteer Page for advanced use cases. */
  readonly raw: Page;

  private readonly _baseUrl: string | undefined;
  private readonly _ctx: BrowserTestContext;
  private readonly _metricsEnabled: boolean;
  private readonly _actionTimeout: number;
  private readonly _options: BrowserOptions;
  private readonly _testId: string;
  /** Owning browser — used to register popups in its open-page accounting. */
  private readonly _owner: GlubeanBrowser | undefined;
  private _evidence: EvidenceSession | null = null;
  private _dialogHandler: DialogHandler | null = null;

  private constructor(
    page: Page,
    baseUrl: string | undefined,
    ctx: BrowserTestContext,
    metricsEnabled: boolean,
    actionTimeout: number,
    options: BrowserOptions,
    testId: string,
    owner: GlubeanBrowser | undefined,
  ) {
    this.raw = page;
    this._baseUrl = baseUrl;
    this._ctx = ctx;
    this._metricsEnabled = metricsEnabled;
    this._actionTimeout = actionTimeout;
    this._options = options;
    this._testId = testId;
    this._owner = owner;
  }

  /** @internal */
  static async _create(
    page: Page,
    baseUrl: string | undefined,
    ctx: BrowserTestContext,
    options: BrowserOptions,
    runtimeTestId?: string,
    owner?: GlubeanBrowser,
  ): Promise<InstrumentedPage> {
    const consoleForward = options.consoleForward ?? true;
    const networkTraceOpt = options.networkTrace ?? true;
    const metricsEnabled = options.metrics ?? true;
    const screenshotMode = options.screenshot ?? "on-failure";
    const screenshotDir = options.screenshotDir ?? ".glubean/screenshots";
    const testId = runtimeTestId ?? ctx.testId ?? "unknown";
    // ONE download dir for the whole browser — NOT per-test. `Browser.setDownloadBehavior`
    // is browser-context-global (last call wins the path), so two concurrent instrumented
    // pages sharing one Chrome (e.g. concurrent tests off one `browser()` fixture) must
    // agree on the directory or one would silently repoint the other's downloads. The
    // per-download `browser:download` evidence carries the testId for attribution instead.
    const downloadDir = options.downloadDir ?? ".glubean/downloads";
    const actionTimeout = options.actionTimeout ?? 30_000;
    const dialogMode: DialogMode = options.dialogMode ?? "dismiss";

    const gp = new GlubeanPage(
      page,
      baseUrl,
      ctx,
      metricsEnabled,
      actionTimeout,
      options,
      testId,
      owner,
    );

    // Native dialogs (alert/confirm/prompt/beforeunload) always emit evidence.
    // Puppeteer auto-dismisses unhandled dialogs UNLESS a 'dialog' listener is
    // registered — once we register one, WE are responsible for resolving
    // every dialog (custom handler via onDialog(), else `dialogMode`).
    page.on("dialog", (dialog) => {
      ctx.event({
        type: "browser:dialog",
        data: {
          dialogType: dialog.type(),
          message: dialog.message(),
          defaultValue: dialog.defaultValue(),
        },
      });
      const handle = async (): Promise<void> => {
        if (gp._dialogHandler) {
          await gp._dialogHandler(dialog);
          return;
        }
        if (dialogMode === "accept") await dialog.accept();
        else await dialog.dismiss();
      };
      handle().catch((err) => {
        ctx.warn(false, `[browser:dialog] failed to resolve dialog: ${String(err)}`);
      });
    });

    // Popups (window.open / target=_blank) always emit evidence. Use
    // page.waitForPopup() to also get a fully-instrumented handle to the
    // popup itself (own evidence session: network/console/screenshots).
    page.on("popup", (popup) => {
      if (!popup) return;
      ctx.event({
        type: "browser:popup",
        data: { url: popup.url() },
      });
    });

    if (consoleForward) {
      page.on("console", (msg) => {
        const type = msg.type();
        const text = msg.text();
        if (type === "error") {
          ctx.event({
            type: "browser:console-error",
            data: { message: text, source: msg.location()?.url },
          });
          ctx.warn(false, `[browser:console] ${text}`);
        } else {
          ctx.log(`[browser:${type}] ${text}`);
        }
      });

      page.on("pageerror", (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        ctx.event({
          type: "browser:uncaught-error",
          data: { message: msg, stack },
        });
        ctx.warn(false, `[browser:uncaught] ${msg}`);
      });
    }

    // One shared evidence CDP session hosts Network trace + Fetch mock +
    // Emulation + Screenshot capture. Each capability is only wired when its
    // config is present.
    const filterOpts = typeof networkTraceOpt === "object" ? networkTraceOpt : undefined;

    // Build the screenshot shoot delegate. It performs I/O (take screenshot,
    // save artifact, emit ctx.event) and is called by EvidenceSession.captureShot
    // when mode+trigger policy allows. Defined here so it closes over `page`,
    // `ctx`, `screenshotDir`, and `testId` without leaking them into EvidenceSession.
    // Always install the shoot delegate so captureScreenshot() (manual, trigger="manual")
    // works even when screenshotMode is "off". The mode only gates automatic triggers
    // (step / failure); manual captures bypass the mode filter inside EvidenceSession.
    const screenshotsOpt = {
      mode: screenshotMode,
      shoot: async (
        filename: string,
        label: string,
        trigger: ScreenshotTrigger,
      ): Promise<{ artifactId?: string; path?: string }> => {
        if (ctx.saveArtifact) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const buffer = (await page.screenshot({
            fullPage: true,
            encoding: "binary",
          } as any)) as unknown as Uint8Array;
          const artifactId = await ctx.saveArtifact(filename, buffer, {
            type: "screenshot",
            mimeType: "image/png",
          });
          ctx.event({
            type: "browser:screenshot",
            data: { artifactId, label, trigger, fullPage: true },
          });
          return { artifactId };
        }
        // Legacy fallback: direct file write when saveArtifact is not available.
        const subdir = `${screenshotDir}/${_sanitizeFilename(testId)}`;
        await _ensureDir(subdir);
        const filePath = `${subdir}/${filename}`;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await page.screenshot({ path: filePath, fullPage: true } as any);
        ctx.event({
          type: "browser:screenshot",
          data: { path: filePath, label, trigger, fullPage: true },
        });
        return { path: filePath };
      },
    };

    // Downloads are always captured as evidence (like dialog/popup) — the
    // save directory must exist before Chrome is told to use it.
    await _ensureDir(downloadDir);

    gp._evidence = await EvidenceSession.attach(page, {
      trace: networkTraceOpt !== false ? (t) => ctx.trace(t) : undefined,
      network: filterOpts && {
        include: filterOpts.include,
        excludePaths: filterOpts.excludePaths,
        filter: filterOpts.filter,
      },
      mocks: options.mock,
      emulate: options.emulate,
      storageState: options.storageState,
      screenshots: screenshotsOpt,
      downloads: {
        dir: downloadDir,
        onDownload: (entry, state) => {
          // Only terminal states are evidence — "inProgress" fires repeatedly
          // per download and would flood the timeline with no new information.
          if (state === "inProgress") return;
          ctx.event({
            type: "browser:download",
            data: {
              guid: entry.guid,
              url: entry.url,
              filename: entry.suggestedFilename,
              path: entry.path,
              state,
            },
          });
        },
      },
    });

    // Proxy: GlubeanPage methods take priority; everything else falls through
    // to the raw Puppeteer Page so users can call page.waitForNavigation(),
    // page.setViewport(), page.keyboard.press(), etc. directly.
    return new Proxy(gp, {
      get(target, prop, receiver) {
        if (prop in target) {
          const value = Reflect.get(target, prop, receiver);
          if (typeof value === "function") return value.bind(target);
          return value;
        }
        const rawValue = Reflect.get(target.raw, prop);
        if (typeof rawValue === "function") return rawValue.bind(target.raw);
        return rawValue;
      },
      has(target, prop) {
        return prop in target || prop in target.raw;
      },
    }) as unknown as InstrumentedPage;
  }

  // ── Screenshot helpers ──────────────────────────────────────────────

  /**
   * Capture a screenshot for a test-level failure (e.g. assertion error).
   *
   * Call this in the fixture's catch block to get a final-state screenshot
   * when the test body throws. Delegates to the shared {@link EvidenceSession}
   * so the capture obeys the configured {@link ScreenshotMode} and the
   * screenshot is recorded in the unified evidence timeline.
   */
  async screenshotOnFailure(): Promise<void> {
    await this._evidence?.captureShot("final", "failure");
  }

  /**
   * Manually capture a screenshot into the evidence stream.
   *
   * Unlike the raw `screenshot()` method (which returns bytes and skips the
   * evidence flow), this always records the capture in the timeline regardless
   * of the configured auto-screenshot mode. Use it for explicit checkpoints
   * inside the test body.
   *
   * @param label — human label for this checkpoint (default: `"manual"`)
   *
   * @example
   * ```ts
   * await page.goto("/checkout");
   * await page.captureScreenshot("cart-loaded");
   * ```
   */
  async captureScreenshot(label = "manual"): Promise<void> {
    await this._evidence?.captureShot(label, "manual");
  }

  // ── Storage state (cookies + localStorage) ──────────────────────────

  /**
   * Capture the current page's cookies + localStorage — a thin "login once,
   * reuse the session" primitive. Pass the result to `browser({ storageState })`
   * on a fresh page to skip a UI login flow.
   *
   * @example
   * ```ts
   * await page.fill('[data-testid="username"]', "ada");
   * await page.click('[data-testid="login-btn"]');
   * const state = await page.getStorageState();
   * ```
   */
  async getStorageState(): Promise<StorageState> {
    if (!this._evidence) return {};
    return await this._evidence.captureStorageState(this.raw);
  }

  // ── Dialog & popup ───────────────────────────────────────────────────

  /**
   * Register a handler for the next native dialogs (`alert`/`confirm`/`prompt`/
   * `beforeunload`) on this page, overriding the plugin's `dialogMode` default.
   * The handler MUST resolve the dialog itself (`dialog.accept()` /
   * `dialog.dismiss()`) — Glubean will not also auto-resolve it.
   *
   * A `browser:dialog` evidence event is emitted for every dialog regardless
   * of whether a handler is registered.
   *
   * @example
   * ```ts
   * page.onDialog((dialog) => dialog.accept());
   * await page.click('[data-testid="clear-cart-btn"]'); // triggers confirm()
   * ```
   */
  onDialog(handler: DialogHandler): void {
    this._dialogHandler = handler;
  }

  /**
   * Run `action`, wait for it to open a popup (`window.open()` / `target="_blank"`),
   * and return the popup as a fully-instrumented page (its own evidence session —
   * network trace, console forwarding, screenshots — just like the parent).
   *
   * A `browser:popup` evidence event is emitted for every popup regardless of
   * whether `waitForPopup()` is used to capture it.
   *
   * @example
   * ```ts
   * const popup = await page.waitForPopup(() => page.click('[data-testid="policy-link"]'));
   * await popup.expectText("body", "Return Policy");
   * await popup.close();
   * ```
   */
  async waitForPopup(
    action: () => Promise<void>,
    options?: { timeout?: number },
  ): Promise<InstrumentedPage> {
    const timeout = options?.timeout ?? this._actionTimeout;
    const start = Date.now();

    // Named listener + timer so BOTH are always cleaned up — a failed wait
    // must not leave a stale `popup` listener behind (it would swallow a later
    // popup and accumulate across repeated failed waits).
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onPopup: ((popup: Page | null) => void) | undefined;
    const popupPromise = new Promise<Page>((resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`waitForPopup: no popup opened after ${timeout}ms`));
      }, timeout);
      onPopup = (popup: Page | null) => {
        if (popup) {
          // Register the popup in the owning browser's open-page accounting
          // SYNCHRONOUSLY on the open event — before awaiting `action()` to
          // settle. Otherwise a popup that opens and closes within `action()`
          // would fire its `close` before `_track()` wired the decrementing
          // listener, permanently pinning `_openPages` above zero and
          // suppressing browser auto-close.
          this._owner?._track(popup);
          resolve(popup);
        } else {
          reject(new Error("waitForPopup: popup event fired with no page"));
        }
      };
      this.raw.once("popup", onPopup);
    });
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      if (onPopup) this.raw.off("popup", onPopup);
    };

    try {
      const [rawPopup] = await Promise.all([popupPromise, action()]);
      cleanup();
      this._ctx.action({
        category: "browser:waitForPopup",
        target: rawPopup.url(),
        duration: Date.now() - start,
        status: "ok",
      });
      return await GlubeanPage._create(
        rawPopup,
        this._baseUrl,
        this._ctx,
        this._options,
        this._testId,
        this._owner,
      );
    } catch (err) {
      cleanup();
      this._ctx.action({
        category: "browser:waitForPopup",
        target: "(popup)",
        duration: Date.now() - start,
        status: "timeout",
        detail: { error: String(err) },
      });
      throw err;
    }
  }

  // ── Downloads ────────────────────────────────────────────────────────

  /**
   * Run `action`, wait for it to produce a completed download, and return
   * the download's metadata. A `browser:download` evidence event is emitted
   * for every download (`completed` or `canceled`) regardless of whether
   * `waitForDownload()` is used to capture it — like `waitForPopup()`.
   *
   * @example
   * ```ts
   * const dl = await page.waitForDownload(() => page.click('[data-testid="download-receipt"]'));
   * ctx.assert(dl.suggestedFilename.endsWith(".txt"), "expected a .txt receipt");
   * ```
   */
  async waitForDownload(
    action: () => Promise<void>,
    options?: { timeout?: number },
  ): Promise<DownloadEntry> {
    const timeout = options?.timeout ?? this._actionTimeout;
    const start = Date.now();
    if (!this._evidence) {
      throw new Error("waitForDownload: evidence session not attached");
    }
    // Register the wait BEFORE the action so a fast download can't slip past,
    // and scope it to THIS action: if `action()` throws, abort the wait so it
    // neither leaks a waiter nor gets satisfied by a later, unrelated download.
    const ac = new AbortController();
    const waitPromise = this._evidence.waitForDownload(timeout, ac.signal);
    try {
      await action();
    } catch (err) {
      ac.abort();
      await waitPromise.catch(() => {}); // settle the aborted wait; swallow its rejection
      this._ctx.action({
        category: "browser:waitForDownload",
        target: "(download)",
        duration: Date.now() - start,
        status: "timeout",
        detail: { error: String(err) },
      });
      throw err;
    }
    try {
      const entry = await waitPromise;
      this._ctx.action({
        category: "browser:waitForDownload",
        target: entry.suggestedFilename,
        duration: Date.now() - start,
        status: "ok",
        detail: { url: entry.url, path: entry.path },
      });
      return entry;
    } catch (err) {
      this._ctx.action({
        category: "browser:waitForDownload",
        target: "(download)",
        duration: Date.now() - start,
        status: "timeout",
        detail: { error: String(err) },
      });
      throw err;
    }
  }

  // ── iframe ───────────────────────────────────────────────────────────

  /**
   * Locate an `<iframe>` matching `selector` and return its content frame,
   * wrapped with the same locator API as `GlubeanPage` (`byTestId`/`byText`/
   * `byRole`/`byLabel`, `click`/`fill`/`type`/`hover`, `expectVisible`/
   * `expectText`/`expectHidden`).
   *
   * CDP already handles the execution-context switch into the frame (that's
   * Puppeteer's own `Frame` machinery) — this method is purely the
   * encapsulation-layer half: locator ergonomics scoped to the frame instead
   * of the top-level page.
   *
   * @example
   * ```ts
   * const policy = await page.frame('[data-testid="policy-frame"]');
   * await policy.expectText("body", "Return Policy");
   * ```
   */
  async frame(
    selector: string,
    options?: ActionOptions,
  ): Promise<GlubeanFrame> {
    const timeout = options?.timeout ?? this._actionTimeout;
    const start = Date.now();
    try {
      const handle = await this.raw.waitForSelector(selector, { timeout });
      if (!handle) {
        throw new Error(`frame("${selector}"): element not found`);
      }
      // try/finally so the handle is disposed even if contentFrame() throws.
      let contentFrame;
      try {
        contentFrame = await handle.contentFrame();
      } finally {
        await handle.dispose();
      }
      if (!contentFrame) {
        throw new Error(
          `frame("${selector}"): element matched but is not an <iframe> (no content frame)`,
        );
      }
      this._ctx.action({
        category: "browser:frame",
        target: selector,
        duration: Date.now() - start,
        status: "ok",
        detail: { url: contentFrame.url() },
      });
      return createFrame(contentFrame, {
        action: (e) => this._ctx.action(e),
        captureStep: (label) => this._evidence?.captureShot(label, "step") ?? Promise.resolve(),
        captureFailure: (label) => this._evidence?.captureShot(label, "failure") ?? Promise.resolve(),
      }, this._actionTimeout);
    } catch (err) {
      this._ctx.action({
        category: "browser:frame",
        target: selector,
        duration: Date.now() - start,
        status: "timeout",
        detail: { error: String(err) },
      });
      await this._evidence?.captureShot(`frame-${selector}`, "failure");
      throw err;
    }
  }

  // ── Navigation & interaction ────────────────────────────────────────

  /**
   * Navigate to a URL. Relative paths are resolved against the configured `baseUrl`.
   *
   * Emits a `browser:goto` action and (if enabled) Navigation Timing metrics.
   * Captures a screenshot on failure or after every step (depending on config).
   */
  async goto(
    url: string,
    options?: {
      waitUntil?:
        | "load"
        | "domcontentloaded"
        | "networkidle0"
        | "networkidle2";
    },
  ): Promise<void> {
    const resolvedUrl = this._resolveUrl(url);
    const start = Date.now();

    let response;
    try {
      response = await this.raw.goto(resolvedUrl, {
        waitUntil: options?.waitUntil ?? "load",
      });
    } catch (err) {
      const duration = Date.now() - start;
      this._ctx.action({
        category: "browser:goto",
        target: url,
        duration,
        status: "error",
        detail: { url: resolvedUrl, error: String(err) },
      });
      await this._evidence?.captureShot(`goto-${url}`, "failure");
      throw err;
    }

    const duration = Date.now() - start;
    const httpStatus = response?.status() ?? 0;

    this._ctx.action({
      category: "browser:goto",
      target: url,
      duration,
      status: httpStatus >= 400 ? "error" : "ok",
      detail: { url: resolvedUrl, httpStatus },
    });

    if (this._metricsEnabled) {
      await collectNavigationMetrics(
        this.raw,
        (name, value, opts) => this._ctx.metric(name, value, opts),
        resolvedUrl,
      );
    }

    await this._evidence?.captureShot(`goto-${url}`, "step");
  }

  /**
   * Create a WrappedLocator for the given selector.
   *
   * The returned locator supports Puppeteer's chain methods (setTimeout,
   * setVisibility, etc.) and auto-injects trace events and screenshots
   * for action methods (click, fill, hover, scroll, type).
   *
   * @example
   * ```ts
   * // Chain Locator options before acting
   * await page.locator("#submit").setTimeout(5000).click();
   *
   * // type() extension — Locator has no native type()
   * await page.locator("#email").type("user@test.com");
   * ```
   */
  locator(selector: string): WrappedLocator {
    const inner = this.raw.locator(selector);
    return createWrappedLocator(inner, {
      action: (e) => this._ctx.action(e),
      captureStep: (label) => this._evidence?.captureShot(label, "step") ?? Promise.resolve(),
      captureFailure: (label) => this._evidence?.captureShot(label, "failure") ?? Promise.resolve(),
    }, selector, this.raw);
  }

  /**
   * Locate an element by its `data-testid` attribute.
   *
   * @example
   * ```ts
   * await page.byTestId("submit-btn").click();
   * await page.byTestId("email").type("user@test.com");
   * ```
   */
  byTestId(id: string): WrappedLocator {
    return this.locator(`[data-testid="${id}"]`);
  }

  /**
   * Locate an element by its visible text content.
   *
   * Uses Puppeteer's built-in text selector (`::-p-text()`).
   *
   * @example
   * ```ts
   * await page.byText("Sign in").click();
   * ```
   */
  byText(text: string): WrappedLocator {
    return this.locator(`::-p-text(${text})`);
  }

  /**
   * Locate an element by its ARIA role (and optionally accessible name).
   *
   * Uses Puppeteer's built-in ARIA selector (`::-p-aria()`).
   *
   * @example
   * ```ts
   * await page.byRole("button", { name: "Submit" }).click();
   * await page.byRole("navigation").hover();
   * ```
   */
  byRole(role: string, options?: { name?: string }): WrappedLocator {
    if (options?.name) {
      return this.locator(`::-p-aria(${options.name}[role="${role}"])`);
    }
    return this.locator(`[role="${role}"]`);
  }

  /**
   * Locate an element by its accessible name (ARIA label).
   *
   * Uses Puppeteer's built-in ARIA selector (`::-p-aria()`).
   *
   * @example
   * ```ts
   * await page.byLabel("Email address").type("user@test.com");
   * ```
   */
  byLabel(label: string): WrappedLocator {
    return this.locator(`::-p-aria(${label})`);
  }

  /**
   * Click an element matching the selector.
   *
   * Delegates to Puppeteer's Locator API for auto-waiting (attached, visible,
   * enabled, stable bounding box). Emits a `browser:click` action for tracing.
   */
  async click(selector: string, options?: ActionOptions): Promise<void> {
    await this.locator(selector)
      .setTimeout(options?.timeout ?? this._actionTimeout)
      .click();
  }

  /**
   * Click an element and wait for a full-page navigation to complete.
   *
   * Convenience wrapper for `Promise.all([waitForNavigation, click])`.
   * Emits a `browser:click-and-navigate` action with trace + metrics + screenshot.
   *
   * @example
   * ```ts
   * await page.clickAndNavigate("a.external-link");
   * await page.clickAndNavigate("a.external-link", { waitUntil: "networkidle0" });
   * ```
   */
  async clickAndNavigate(
    selector: string,
    options?: {
      waitUntil?:
        | "load"
        | "domcontentloaded"
        | "networkidle0"
        | "networkidle2";
      timeout?: number;
    },
  ): Promise<void> {
    const start = Date.now();
    const timeout = options?.timeout ?? this._actionTimeout;
    try {
      await Promise.all([
        this.raw.waitForNavigation({
          waitUntil: options?.waitUntil ?? "load",
          timeout,
        }),
        this.locator(selector).setTimeout(timeout).click(),
      ]);

      const duration = Date.now() - start;
      this._ctx.action({
        category: "browser:click-and-navigate",
        target: selector,
        duration,
        status: "ok",
        detail: { url: this.raw.url() },
      });

      if (this._metricsEnabled) {
        await collectNavigationMetrics(
          this.raw,
          (name, value, opts) => this._ctx.metric(name, value, opts),
          this.raw.url(),
        );
      }
    } catch (err) {
      const duration = Date.now() - start;
      this._ctx.action({
        category: "browser:click-and-navigate",
        target: selector,
        duration,
        status: "error",
        detail: { error: String(err) },
      });
      await this._evidence?.captureShot(`clickAndNavigate-${selector}`, "failure");
      throw err;
    }
    await this._evidence?.captureShot(`clickAndNavigate-${selector}`, "step");
  }

  /**
   * Type text into an element matching the selector (appends — does not clear).
   *
   * Waits for the element to be actionable via Locator, then types using
   * the ElementHandle. Use `fill()` to clear existing text before typing.
   */
  async type(
    selector: string,
    text: string,
    options?: ActionOptions,
  ): Promise<void> {
    await (this.locator(selector)
      .setTimeout(options?.timeout ?? this._actionTimeout) as WrappedLocator)
      .type(text);
  }

  /**
   * Clear an input and type a new value.
   *
   * Unlike `type()` which appends, `fill()` clears existing text first.
   * Delegates to Puppeteer's Locator `fill()` for auto-waiting.
   */
  async fill(
    selector: string,
    value: string,
    options?: ActionOptions,
  ): Promise<void> {
    await this.locator(selector)
      .setTimeout(options?.timeout ?? this._actionTimeout)
      .fill(value);
  }

  /**
   * Hover over an element matching the selector.
   *
   * Delegates to Puppeteer's Locator `hover()` for auto-waiting.
   */
  async hover(selector: string, options?: ActionOptions): Promise<void> {
    await this.locator(selector)
      .setTimeout(options?.timeout ?? this._actionTimeout)
      .hover();
  }

  /**
   * Select option(s) from a `<select>` element by value.
   *
   * Waits for the element to be actionable via Locator, then selects values.
   * Returns the array of selected values.
   */
  async select(
    selector: string,
    ...values: string[]
  ): Promise<string[]> {
    const start = Date.now();
    try {
      // Use waitForSelector + page.evaluate() to avoid Puppeteer 24's Locator
      // private field issue (#waitForVisibilityIfNeeded)
      await this.raw.waitForSelector(selector, { timeout: this._actionTimeout });
      const selected = await this.raw.evaluate(
        (sel: string, vals: string[]) => {
          const el = document.querySelector(sel) as HTMLSelectElement;
          if (!el) throw new Error(`select: element not found: ${sel}`);
          for (const opt of Array.from(el.options)) {
            opt.selected = vals.includes(opt.value);
          }
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return Array.from(el.selectedOptions).map((o) => o.value);
        },
        selector,
        values,
      );
      const duration = Date.now() - start;
      this._ctx.action({
        category: "browser:select",
        target: selector,
        duration,
        status: "ok",
        detail: { values, selected },
      });
      return selected;
    } catch (err) {
      const duration = Date.now() - start;
      this._ctx.action({
        category: "browser:select",
        target: selector,
        duration,
        status: "timeout",
        detail: { values, error: String(err) },
      });
      await this._evidence?.captureShot(`select-${selector}`, "failure");
      throw err;
    }
  }

  /**
   * Press a keyboard key (e.g. `"Enter"`, `"Tab"`, `"Escape"`).
   *
   * Operates at the keyboard level — no selector or auto-wait needed.
   */
  async press(
    key: string,
    options?: { text?: string },
  ): Promise<void> {
    const start = Date.now();
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await this.raw.keyboard.press(key as any, options);
      const duration = Date.now() - start;
      this._ctx.action({
        category: "browser:press",
        target: key,
        duration,
        status: "ok",
      });
    } catch (err) {
      const duration = Date.now() - start;
      this._ctx.action({
        category: "browser:press",
        target: key,
        duration,
        status: "error",
        detail: { error: String(err) },
      });
      throw err;
    }
  }

  /**
   * Upload files to a `<input type="file">` element.
   *
   * Waits for the element to be actionable via Locator, then attaches files
   * via `ElementHandle.uploadFile()` and dispatches a `change` event so
   * frameworks like React/Vue pick up the file selection.
   */
  async upload(
    selector: string,
    ...filePaths: string[]
  ): Promise<void> {
    const start = Date.now();
    try {
      const handle = await this.locator(selector)
        .setTimeout(this._actionTimeout)
        .waitHandle();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (handle as any).uploadFile(...filePaths);
      // Puppeteer's uploadFile sets files via CDP but does NOT fire the
      // native change event. React/Vue rely on it to update state.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await handle.evaluate((el: any) =>
        el.dispatchEvent(new Event("change", { bubbles: true })),
      );
      await handle.dispose();
      const duration = Date.now() - start;
      this._ctx.action({
        category: "browser:upload",
        target: selector,
        duration,
        status: "ok",
        detail: { fileCount: filePaths.length },
      });
    } catch (err) {
      const duration = Date.now() - start;
      this._ctx.action({
        category: "browser:upload",
        target: selector,
        duration,
        status: "timeout",
        detail: { fileCount: filePaths.length, error: String(err) },
      });
      await this._evidence?.captureShot(`upload-${selector}`, "failure");
      throw err;
    }
    await this._evidence?.captureShot(`upload-${selector}`, "step");
  }

  /**
   * Click a button/element that triggers a file chooser dialog, then accept
   * the given files. Use this when the file input is hidden and opened via
   * a custom button — the common pattern in modern SPAs.
   *
   * For a visible `<input type="file">`, prefer `upload()` instead.
   *
   * @example
   * ```ts
   * await page.chooseFile("#import-csv-btn", "./fixtures/users.csv");
   * ```
   */
  async chooseFile(
    triggerSelector: string,
    ...filePaths: string[]
  ): Promise<void> {
    const start = Date.now();
    try {
      const [fileChooser] = await Promise.all([
        this.raw.waitForFileChooser({ timeout: this._actionTimeout }),
        this.click(triggerSelector),
      ]);
      await fileChooser.accept(filePaths);
      const duration = Date.now() - start;
      this._ctx.action({
        category: "browser:chooseFile",
        target: triggerSelector,
        duration,
        status: "ok",
        detail: { fileCount: filePaths.length },
      });
    } catch (err) {
      const duration = Date.now() - start;
      this._ctx.action({
        category: "browser:chooseFile",
        target: triggerSelector,
        duration,
        status: "timeout",
        detail: { fileCount: filePaths.length, error: String(err) },
      });
      await this._evidence?.captureShot(`chooseFile-${triggerSelector}`, "failure");
      throw err;
    }
    await this._evidence?.captureShot(`chooseFile-${triggerSelector}`, "step");
  }

  /** Query a single element by selector. */
  async $(selector: string): Promise<ElementHandle | null> {
    return await this.raw.$(selector);
  }

  /** Query all elements by selector. */
  async $$(selector: string): Promise<ElementHandle[]> {
    return await this.raw.$$(selector);
  }

  /** Evaluate a function in the browser page context. */
  async evaluate<T>(
    fn: (...args: unknown[]) => T,
    ...args: unknown[]
  ): Promise<T> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await this.raw.evaluate(fn as any, ...args);
  }

  /** Take a screenshot. Returns the image as a Buffer or base64 string. */
  async screenshot(
    options?: { encoding?: "binary" | "base64"; fullPage?: boolean },
  ): Promise<string | Uint8Array> {
    return await this.raw.screenshot({
      encoding: options?.encoding ?? "binary",
      fullPage: options?.fullPage ?? false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  }

  /** Current page URL. */
  url(): string {
    return this.raw.url();
  }

  /** Current page title. */
  async title(): Promise<string> {
    return await this.raw.title();
  }

  // ── Retry utility ─────────────────────────────────────────────────

  private static readonly _POLL_MS = 100;

  /**
   * Poll `fn` until `check(result)` returns true, or throw after `timeout` ms.
   * Used by all `waitFor*`, `textContent`, and `expect*` methods.
   */
  private async _retryUntil<T>(
    fn: () => Promise<T>,
    check: (val: T) => boolean,
    errorMsg: (lastVal: T) => string,
    options?: { timeout?: number },
  ): Promise<T> {
    const timeout = options?.timeout ?? 5_000;
    const start = Date.now();
    let lastVal: T | undefined;

    while (Date.now() - start < timeout) {
      try {
        lastVal = await fn();
        if (check(lastVal)) return lastVal;
      } catch {
        // element may not exist yet — retry
      }
      await new Promise((r) => setTimeout(r, GlubeanPage._POLL_MS));
    }

    // One final attempt
    try {
      lastVal = await fn();
      if (check(lastVal!)) return lastVal!;
    } catch {
      // fall through to error
    }

    throw new Error(errorMsg(lastVal as T));
  }

  // ── Phase 4: Navigation Auto-Wait ────────────────────────────────

  /**
   * Wait until the page URL matches `pattern` (string contains or RegExp test).
   *
   * @example
   * ```ts
   * await page.click('a[href="/dashboard"]');
   * await page.waitForURL('/dashboard');
   * ```
   */
  async waitForURL(
    pattern: string | RegExp,
    options?: { timeout?: number },
  ): Promise<void> {
    const matches = (url: string) =>
      typeof pattern === "string" ? url.includes(pattern) : pattern.test(url);

    const start = Date.now();
    try {
      await this._retryUntil(
        () => Promise.resolve(this.raw.url()),
        matches,
        (lastUrl) =>
          `waitForURL: page URL "${lastUrl}" did not match ` +
          `"${pattern}" after ${options?.timeout ?? 5_000}ms`,
        { timeout: options?.timeout ?? this._actionTimeout },
      );
      this._ctx.action({
        category: "browser:wait",
        target: `URL matches ${String(pattern)}`,
        duration: Date.now() - start,
        status: "ok",
      });
    } catch (err) {
      this._ctx.action({
        category: "browser:wait",
        target: `URL matches ${String(pattern)}`,
        duration: Date.now() - start,
        status: "timeout",
        detail: { error: String(err) },
      });
      throw err;
    }
  }

  /**
   * Wait for an element to appear, then return its `textContent`.
   */
  async textContent(
    selector: string,
    options?: { timeout?: number },
  ): Promise<string | null> {
    const start = Date.now();
    const timeout = options?.timeout ?? this._actionTimeout;
    try {
      await this.raw.waitForSelector(selector, { timeout });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await this.raw.$eval(
        selector,
        (el: any) => el.textContent,
      );
      this._ctx.action({
        category: "browser:wait",
        target: `textContent("${selector}")`,
        duration: Date.now() - start,
        status: "ok",
      });
      return result;
    } catch (err) {
      this._ctx.action({
        category: "browser:wait",
        target: `textContent("${selector}")`,
        duration: Date.now() - start,
        status: "timeout",
        detail: { error: String(err) },
      });
      throw err;
    }
  }

  /**
   * Wait for an element to appear, then return its `innerText`.
   */
  async innerText(
    selector: string,
    options?: { timeout?: number },
  ): Promise<string> {
    const start = Date.now();
    const timeout = options?.timeout ?? this._actionTimeout;
    try {
      await this.raw.waitForSelector(selector, { timeout });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await this.raw.$eval(selector, (el: any) => el.innerText);
      this._ctx.action({
        category: "browser:wait",
        target: `innerText("${selector}")`,
        duration: Date.now() - start,
        status: "ok",
      });
      return result;
    } catch (err) {
      this._ctx.action({
        category: "browser:wait",
        target: `innerText("${selector}")`,
        duration: Date.now() - start,
        status: "timeout",
        detail: { error: String(err) },
      });
      throw err;
    }
  }

  /**
   * Wait for an element to appear, then return the value of `attr`.
   */
  async getAttribute(
    selector: string,
    attr: string,
    options?: { timeout?: number },
  ): Promise<string | null> {
    const start = Date.now();
    const timeout = options?.timeout ?? this._actionTimeout;
    try {
      await this.raw.waitForSelector(selector, { timeout });
      const result = await this.raw.$eval(
        selector,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (el: any, a: string) => el.getAttribute(a),
        attr,
      );
      this._ctx.action({
        category: "browser:wait",
        target: `getAttribute("${selector}", "${attr}")`,
        duration: Date.now() - start,
        status: "ok",
      });
      return result;
    } catch (err) {
      this._ctx.action({
        category: "browser:wait",
        target: `getAttribute("${selector}", "${attr}")`,
        duration: Date.now() - start,
        status: "timeout",
        detail: { error: String(err) },
      });
      throw err;
    }
  }

  /**
   * Wait for an input element to appear, then return its `.value`.
   */
  async inputValue(
    selector: string,
    options?: { timeout?: number },
  ): Promise<string> {
    const start = Date.now();
    const timeout = options?.timeout ?? this._actionTimeout;
    try {
      await this.raw.waitForSelector(selector, { timeout });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await this.raw.$eval(
        selector,
        (el: any) => el.value ?? "",
      );
      this._ctx.action({
        category: "browser:wait",
        target: `inputValue("${selector}")`,
        duration: Date.now() - start,
        status: "ok",
      });
      return result;
    } catch (err) {
      this._ctx.action({
        category: "browser:wait",
        target: `inputValue("${selector}")`,
        duration: Date.now() - start,
        status: "timeout",
        detail: { error: String(err) },
      });
      throw err;
    }
  }

  /**
   * Check whether an element is currently visible (non-zero box, not hidden).
   * Returns immediately — does not wait.
   */
  async isVisible(selector: string): Promise<boolean> {
    const handle = await this.raw.$(selector);
    if (!handle) return false;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return await handle.evaluate((el: any) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const style = (globalThis as any).getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") {
          return false;
        }
        const box = el.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      });
    } finally {
      await handle.dispose();
    }
  }

  /**
   * Check whether an element is currently enabled (not disabled).
   * Returns immediately — does not wait.
   */
  async isEnabled(selector: string): Promise<boolean> {
    const handle = await this.raw.$(selector);
    if (!handle) return false;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return await handle.evaluate((el: any) => {
        if ("disabled" in el && !!el.disabled) return false;
        return el.getAttribute("aria-disabled") !== "true";
      });
    } finally {
      await handle.dispose();
    }
  }

  // ── Phase 5: Assertion Auto-Retry ────────────────────────────────

  /**
   * Assert that the page URL matches `pattern`. Retries until match or timeout.
   *
   * @example
   * ```ts
   * await page.click('button[type="submit"]');
   * await page.expectURL('/dashboard');
   * ```
   */
  async expectURL(
    pattern: string | RegExp,
    options?: { timeout?: number },
  ): Promise<void> {
    const matches = (url: string) =>
      typeof pattern === "string" ? url.includes(pattern) : pattern.test(url);

    const start = Date.now();
    try {
      await this._retryUntil(
        () => Promise.resolve(this.raw.url()),
        matches,
        (lastUrl) =>
          `expectURL: page URL "${lastUrl}" did not match ` +
          `"${pattern}" after ${options?.timeout ?? 5_000}ms`,
        options,
      );
      this._ctx.action({
        category: "browser:assert",
        target: `expectURL(${JSON.stringify(String(pattern))})`,
        duration: Date.now() - start,
        status: "ok",
      });
    } catch (err) {
      await this._evidence?.captureShot(`expectURL-${String(pattern)}`, "failure");
      this._ctx.action({
        category: "browser:assert",
        target: `expectURL(${JSON.stringify(String(pattern))})`,
        duration: Date.now() - start,
        status: "timeout",
        detail: { error: String(err) },
      });
      throw err;
    }
  }

  /**
   * Assert that an element's text content matches `expected`. Retries until match or timeout.
   *
   * By default, text is normalized (trimmed + collapsed whitespace) and matched
   * with `includes`. Use `exact: true` for strict equality or pass a `RegExp`
   * for pattern matching.
   */
  async expectText(
    selector: string,
    expected: string | RegExp,
    options?: { timeout?: number; exact?: boolean; ignoreCase?: boolean },
  ): Promise<void> {
    const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
    const matches = (text: string | null) => {
      if (text === null) return false;
      if (expected instanceof RegExp) return expected.test(text);
      const norm = normalize(text);
      const exp = normalize(expected);
      if (options?.exact) {
        return options?.ignoreCase
          ? norm.toLowerCase() === exp.toLowerCase()
          : norm === exp;
      }
      return options?.ignoreCase
        ? norm.toLowerCase().includes(exp.toLowerCase())
        : norm.includes(exp);
    };

    const start = Date.now();
    let lastVal: string | null = null;
    try {
      lastVal = await this._retryUntil(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        () =>
          this.raw.$eval(selector, (el: any) => el.textContent as string | null)
            .catch(() => null),
        matches,
        (lv) =>
          `expectText("${selector}"): expected ${JSON.stringify(expected)} ` +
          `but received ${JSON.stringify(lv)} after ${
            options?.timeout ?? 5_000
          }ms`,
        options,
      );
      this._ctx.action({
        category: "browser:assert",
        target: `expectText("${selector}")`,
        duration: Date.now() - start,
        status: "ok",
        detail: { expected: String(expected), actual: lastVal },
      });
    } catch (err) {
      await this._evidence?.captureShot(`expectText-${selector}`, "failure");
      this._ctx.action({
        category: "browser:assert",
        target: `expectText("${selector}")`,
        duration: Date.now() - start,
        status: "timeout",
        detail: {
          expected: String(expected),
          actual: lastVal,
          error: String(err),
        },
      });
      throw err;
    }
  }

  /**
   * Assert that an element is visible. Retries until visible or timeout.
   */
  async expectVisible(
    selector: string,
    options?: { timeout?: number },
  ): Promise<void> {
    const start = Date.now();
    try {
      await this._retryUntil(
        () => this.isVisible(selector),
        (visible) => visible === true,
        () =>
          `expectVisible("${selector}"): element was not visible ` +
          `after ${options?.timeout ?? 5_000}ms`,
        options,
      );
      this._ctx.action({
        category: "browser:assert",
        target: `expectVisible("${selector}")`,
        duration: Date.now() - start,
        status: "ok",
      });
    } catch (err) {
      await this._evidence?.captureShot(`expectVisible-${selector}`, "failure");
      this._ctx.action({
        category: "browser:assert",
        target: `expectVisible("${selector}")`,
        duration: Date.now() - start,
        status: "timeout",
        detail: { error: String(err) },
      });
      throw err;
    }
  }

  /**
   * Assert that an element is hidden or absent. Retries until hidden or timeout.
   */
  async expectHidden(
    selector: string,
    options?: { timeout?: number },
  ): Promise<void> {
    const start = Date.now();
    try {
      await this._retryUntil(
        () => this.isVisible(selector),
        (visible) => visible === false,
        () =>
          `expectHidden("${selector}"): element was still visible ` +
          `after ${options?.timeout ?? 5_000}ms`,
        options,
      );
      this._ctx.action({
        category: "browser:assert",
        target: `expectHidden("${selector}")`,
        duration: Date.now() - start,
        status: "ok",
      });
    } catch (err) {
      await this._evidence?.captureShot(`expectHidden-${selector}`, "failure");
      this._ctx.action({
        category: "browser:assert",
        target: `expectHidden("${selector}")`,
        duration: Date.now() - start,
        status: "timeout",
        detail: { error: String(err) },
      });
      throw err;
    }
  }

  /**
   * Assert that an element has an attribute matching `expected`. Retries until match or timeout.
   */
  async expectAttribute(
    selector: string,
    attr: string,
    expected: string | RegExp,
    options?: { timeout?: number },
  ): Promise<void> {
    const matches = (val: string | null) => {
      if (val === null) return false;
      return typeof expected === "string"
        ? val === expected
        : expected.test(val);
    };

    const start = Date.now();
    let lastVal: string | null = null;
    try {
      lastVal = await this._retryUntil(
        () =>
          this.raw.$eval(
            selector,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (el: any, a: string) => el.getAttribute(a) as string | null,
            attr,
          ).catch(() => null),
        matches,
        (lv) =>
          `expectAttribute("${selector}", "${attr}"): expected ${
            JSON.stringify(expected)
          } ` +
          `but received ${JSON.stringify(lv)} after ${
            options?.timeout ?? 5_000
          }ms`,
        options,
      );
      this._ctx.action({
        category: "browser:assert",
        target: `expectAttribute("${selector}", "${attr}")`,
        duration: Date.now() - start,
        status: "ok",
        detail: { expected: String(expected), actual: lastVal },
      });
    } catch (err) {
      await this._evidence?.captureShot(`expectAttribute-${selector}-${attr}`, "failure");
      this._ctx.action({
        category: "browser:assert",
        target: `expectAttribute("${selector}", "${attr}")`,
        duration: Date.now() - start,
        status: "timeout",
        detail: {
          expected: String(expected),
          actual: lastVal,
          error: String(err),
        },
      });
      throw err;
    }
  }

  /**
   * Assert that the number of elements matching `selector` equals `expected`. Retries until match or timeout.
   */
  async expectCount(
    selector: string,
    expected: number,
    options?: { timeout?: number },
  ): Promise<void> {
    const start = Date.now();
    let lastCount = 0;
    try {
      lastCount = await this._retryUntil(
        async () => (await this.raw.$$(selector)).length,
        (count) => count === expected,
        (lc) =>
          `expectCount("${selector}"): expected ${expected} elements ` +
          `but found ${lc} after ${options?.timeout ?? 5_000}ms`,
        options,
      );
      this._ctx.action({
        category: "browser:assert",
        target: `expectCount("${selector}")`,
        duration: Date.now() - start,
        status: "ok",
        detail: { expected, actual: lastCount },
      });
    } catch (err) {
      await this._evidence?.captureShot(`expectCount-${selector}`, "failure");
      this._ctx.action({
        category: "browser:assert",
        target: `expectCount("${selector}")`,
        duration: Date.now() - start,
        status: "timeout",
        detail: { expected, actual: lastCount, error: String(err) },
      });
      throw err;
    }
  }

  /**
   * Assert that a checkbox/radio's `.checked` state matches `expected`.
   * Retries until match or timeout.
   *
   * @param expected — desired `.checked` value. @default true
   */
  async expectChecked(
    selector: string,
    expected = true,
    options?: { timeout?: number },
  ): Promise<void> {
    const start = Date.now();
    let lastVal: boolean | null = null;
    try {
      lastVal = await this._retryUntil(
        () =>
          this.raw.$eval(
            selector,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (el: any) => Boolean(el.checked),
          ).catch(() => null as unknown as boolean),
        (val) => val === expected,
        (lv) =>
          `expectChecked("${selector}"): expected checked=${expected} ` +
          `but received checked=${JSON.stringify(lv)} after ${
            options?.timeout ?? 5_000
          }ms`,
        options,
      );
      this._ctx.action({
        category: "browser:assert",
        target: `expectChecked("${selector}")`,
        duration: Date.now() - start,
        status: "ok",
        detail: { expected, actual: lastVal },
      });
    } catch (err) {
      await this._evidence?.captureShot(`expectChecked-${selector}`, "failure");
      this._ctx.action({
        category: "browser:assert",
        target: `expectChecked("${selector}")`,
        duration: Date.now() - start,
        status: "timeout",
        detail: { expected, actual: lastVal, error: String(err) },
      });
      throw err;
    }
  }

  /**
   * Assert that an input/textarea/select's `.value` matches `expected`.
   * Retries until match or timeout. For text content of non-form elements,
   * use `expectText()` instead.
   */
  async expectValue(
    selector: string,
    expected: string | RegExp,
    options?: { timeout?: number },
  ): Promise<void> {
    const matches = (val: string | null) => {
      if (val === null) return false;
      return expected instanceof RegExp ? expected.test(val) : val === expected;
    };

    const start = Date.now();
    let lastVal: string | null = null;
    try {
      lastVal = await this._retryUntil(
        () =>
          this.raw.$eval(
            selector,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (el: any) => (el.value ?? "") as string,
          ).catch(() => null),
        matches,
        (lv) =>
          `expectValue("${selector}"): expected ${JSON.stringify(expected)} ` +
          `but received ${JSON.stringify(lv)} after ${
            options?.timeout ?? 5_000
          }ms`,
        options,
      );
      this._ctx.action({
        category: "browser:assert",
        target: `expectValue("${selector}")`,
        duration: Date.now() - start,
        status: "ok",
        detail: { expected: String(expected), actual: lastVal },
      });
    } catch (err) {
      await this._evidence?.captureShot(`expectValue-${selector}`, "failure");
      this._ctx.action({
        category: "browser:assert",
        target: `expectValue("${selector}")`,
        duration: Date.now() - start,
        status: "timeout",
        detail: {
          expected: String(expected),
          actual: lastVal,
          error: String(err),
        },
      });
      throw err;
    }
  }

  // ── Phase 8: Network Interception & Assertions ────────────────────

  /**
   * Wait for a network request matching `pattern`.
   *
   * @param pattern URL string, RegExp, or predicate function.
   * @returns The matched `HTTPRequest`.
   */
  async waitForRequest(
    pattern: string | RegExp | ((req: HTTPRequest) => boolean),
    options?: { timeout?: number },
  ): Promise<HTTPRequest> {
    const timeout = options?.timeout ?? this._actionTimeout;
    const label = typeof pattern === "function"
      ? "(predicate)"
      : String(pattern);
    const start = Date.now();
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const predicate: any = typeof pattern === "string"
        ? (req: HTTPRequest) => req.url().includes(pattern)
        : pattern instanceof RegExp
        ? (req: HTTPRequest) => pattern.test(req.url())
        : pattern;
      const req = await this.raw.waitForRequest(predicate, { timeout });
      this._ctx.action({
        category: "browser:wait",
        target: `waitForRequest(${label})`,
        duration: Date.now() - start,
        status: "ok",
        detail: { url: req.url(), method: req.method() },
      });
      return req;
    } catch (err) {
      this._ctx.action({
        category: "browser:wait",
        target: `waitForRequest(${label})`,
        duration: Date.now() - start,
        status: "timeout",
        detail: { error: String(err) },
      });
      throw err;
    }
  }

  /**
   * Wait for a network response matching `pattern`.
   *
   * @param pattern URL string, RegExp, or predicate function.
   * @returns The matched `HTTPResponse`.
   */
  async waitForResponse(
    pattern: string | RegExp | ((res: HTTPResponse) => boolean),
    options?: { timeout?: number },
  ): Promise<HTTPResponse> {
    const timeout = options?.timeout ?? this._actionTimeout;
    const label = typeof pattern === "function"
      ? "(predicate)"
      : String(pattern);
    const start = Date.now();
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const predicate: any = typeof pattern === "string"
        ? (res: HTTPResponse) => res.url().includes(pattern)
        : pattern instanceof RegExp
        ? (res: HTTPResponse) => pattern.test(res.url())
        : pattern;
      const res = await this.raw.waitForResponse(predicate, { timeout });
      this._ctx.action({
        category: "browser:wait",
        target: `waitForResponse(${label})`,
        duration: Date.now() - start,
        status: "ok",
        detail: { url: res.url(), status: res.status() },
      });
      return res;
    } catch (err) {
      this._ctx.action({
        category: "browser:wait",
        target: `waitForResponse(${label})`,
        duration: Date.now() - start,
        status: "timeout",
        detail: { error: String(err) },
      });
      throw err;
    }
  }

  /**
   * Assert that a network response matching `pattern` satisfies `checks`.
   *
   * Waits for the response, then validates status and/or headers.
   * Emits a `browser:assert` action.
   *
   * @example
   * ```ts
   * await page.click("#submit");
   * await page.expectResponse("/api/login", { status: 200 });
   * ```
   */
  async expectResponse(
    pattern: string | RegExp | ((res: HTTPResponse) => boolean),
    checks?: ResponseChecks,
    options?: { timeout?: number },
  ): Promise<HTTPResponse> {
    const label = typeof pattern === "function"
      ? "(predicate)"
      : String(pattern);
    const start = Date.now();
    try {
      const res = await this.waitForResponse(pattern, options);
      const failures: string[] = [];

      if (checks?.status !== undefined) {
        const s = res.status();
        const ok = typeof checks.status === "function"
          ? checks.status(s)
          : s === checks.status;
        if (!ok) failures.push(`status ${s} did not match ${checks.status}`);
      }

      if (checks?.headerContains) {
        const headers = res.headers();
        for (const [key, expected] of Object.entries(checks.headerContains)) {
          const actual = headers[key.toLowerCase()];
          if (!actual || !actual.includes(expected)) {
            const display = actual ?? "(missing)";
            failures.push(
              "header " + JSON.stringify(key) + ": expected " +
                JSON.stringify(expected) + ", got " + JSON.stringify(display),
            );
          }
        }
      }

      if (failures.length > 0) {
        const msg = "expectResponse(" + label + "): " + failures.join("; ");
        this._ctx.action({
          category: "browser:assert",
          target: "expectResponse(" + label + ")",
          duration: Date.now() - start,
          status: "error",
          detail: { url: res.url(), httpStatus: res.status(), failures },
        });
        throw new Error(msg);
      }

      this._ctx.action({
        category: "browser:assert",
        target: `expectResponse(${label})`,
        duration: Date.now() - start,
        status: "ok",
        detail: { url: res.url(), httpStatus: res.status() },
      });
      return res;
    } catch (err) {
      if (
        !(err instanceof Error && err.message.startsWith("expectResponse("))
      ) {
        this._ctx.action({
          category: "browser:assert",
          target: `expectResponse(${label})`,
          duration: Date.now() - start,
          status: "timeout",
          detail: { error: String(err) },
        });
      }
      throw err;
    }
  }

  /** Clean up: detach the shared evidence CDP session and close the page. */
  async close(): Promise<void> {
    if (this._evidence) {
      await this._evidence.detach();
      this._evidence = null;
    }
    try {
      await this.raw.close();
    } catch {
      // page may already be closed
    }

    // Close leftover blank tabs so Chrome doesn't linger with an empty window.
    try {
      const browser = this.raw.browser();
      const remaining = await browser.pages();
      const allBlank = remaining.length > 0 && remaining.every((p) => {
        const url = p.url();
        return url === "about:blank" || url === "chrome://new-tab-page/";
      });
      if (allBlank) {
        for (const p of remaining) {
          try { await p.close(); } catch { /* ignore */ }
        }
      }
    } catch {
      // best-effort cleanup
    }
  }

  private _resolveUrl(url: string): string {
    if (!this._baseUrl) return url;
    if (url.startsWith("http://") || url.startsWith("https://")) return url;

    const base = this._baseUrl.endsWith("/")
      ? this._baseUrl.slice(0, -1)
      : this._baseUrl;
    const path = url.startsWith("/") ? url : `/${url}`;
    return `${base}${path}`;
  }
}
