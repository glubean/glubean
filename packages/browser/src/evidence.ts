/**
 * Shared evidence CDP session — the foundation for browser evidence capture.
 *
 * A single self-opened `createCDPSession` hosts **all** CDP-backed capabilities
 * at once, instead of opening one session per capability:
 *
 * - **Network trace** (`Network` domain) — every in-page request as a Glubean
 *   trace event (see {@link ./network.ts}).
 * - **Request mock** (`Fetch` domain) — fulfill matching requests with a canned
 *   response; non-matching requests are continued untouched.
 * - **Emulation** (`Emulation` domain) — timezone / geolocation / viewport / user agent.
 * - **Storage state** — restore cookies / localStorage before the page's
 *   first script runs, and capture them back out on demand (a thin "login
 *   once, reuse the session" primitive). Cookies go through this session's
 *   `Network.setCookies` (browser-context scoped, session-agnostic in CDP).
 *   localStorage does **not** — see guardrail ③.
 *
 * The keystone spike disproved the "Fetch is near-exclusive" hypothesis: a
 * self-opened session running `Fetch.enable`/`fulfillRequest` is stable **as
 * long as the user has not enabled Puppeteer's own request interception**.
 * Three coexistence hazards exist, each handled below:
 *
 * **Guardrail ① — viewport ownership.** Our `Emulation.setDeviceMetricsOverride`
 * and Puppeteer's `page.setViewport()` both drive device metrics and clobber
 * each other last-wins. When `emulate.viewport` is configured, Glubean is the
 * sole owner: it applies the viewport last and blocks `page.setViewport()` with
 * a clear error so the two never race.
 *
 * **Guardrail ② — Fetch double-open.** If the user turns on Puppeteer request
 * interception (`page.setRequestInterception(true)`) while our `Fetch` mock is
 * active, both stacks try to handle the same paused request and fulfillment
 * conflicts. When mocks are enabled, Glubean owns `Fetch` and blocks
 * `page.setRequestInterception(true)` with a clear error. When no mocks are
 * configured we never enable `Fetch`, so the user's own interception is free.
 *
 * **Guardrail ③ — new-document scripts need Puppeteer's OWN session.**
 * Verified empirically: sending `Page.addScriptToEvaluateOnNewDocument` on
 * our *auxiliary* `page.createCDPSession()` session registers without error
 * (a real `identifier` comes back) but the script never actually fires on
 * subsequent navigations — only the session Puppeteer itself uses for the
 * page's frame-lifecycle bookkeeping gets its new-document scripts run.
 * `storageState.localStorage` therefore seeds via Puppeteer's own
 * `page.evaluateOnNewDocument()`, not a raw CDP call on this session.
 *
 * **Downloads** (`Browser` domain, BT1-M5) — `Browser.setDownloadBehavior`
 * with `eventsEnabled: true`, called on this same auxiliary session, both
 * configures the save directory AND (unlike guardrail ③'s Page-domain
 * finding) reliably delivers `Browser.downloadWillBegin` /
 * `Browser.downloadProgress` back on THIS session — verified empirically
 * (spike script) against puppeteer-core ^24; `Browser.*` is genuinely
 * session-agnostic where `Page.addScriptToEvaluateOnNewDocument` was not.
 * The deprecated `Page.setDownloadBehavior` / `Page.downloadWillBegin` also
 * work on the same spike but `Browser.*` is the protocol's forward path, so
 * that's what's wired here. One caveat verified in the same spike: the file
 * on disk is saved as `suggestedFilename`, not `guid` (despite some CDP docs
 * implying the latter) — `DownloadEntry.path` is built from that name, which
 * is only exact when Chrome didn't have to de-duplicate a collision.
 * Always wired when a page is created (like dialog/popup) — a download IS
 * evidence the moment it happens, not an opt-in capability.
 *
 * **Guardrail ④ — download events are browser-context-global.** Unlike the
 * page-scoped `Network`/`Fetch` domains, `Browser.setDownloadBehavior` sets a
 * single context-wide save path (last caller wins) and its `downloadWillBegin`/
 * `downloadProgress` events fire on *every* session that turned events on, for
 * *every* download in the context. So two instrumented pages in one Chrome
 * would otherwise cross-observe and cross-repoint each other's downloads. Two
 * mitigations: (a) the page layer uses ONE browser-wide download dir (not
 * per-test) so the last-wins path is a no-op; (b) this session enables the
 * `Page` domain, tracks its target's frame ids (`Page.getFrameTree` +
 * `frameAttached`/`frameDetached`), and only records downloads whose
 * originating `frameId` it owns — so a page never resolves another page's
 * download. Both degrade safely: an unreadable frame tree falls back to
 * accepting all events (single-page runs are unaffected).
 *
 * @module evidence
 */

import type { CDPSession, Page } from "puppeteer-core";
import {
  attachNetworkTracer,
  type NetworkTracerOptions,
  type TraceFn,
} from "./network.js";

// ── Screenshot types ───────────────────────────────────────────────────

/**
 * When screenshots are automatically captured into the evidence stream.
 *
 * - `"off"` — no automatic screenshots
 * - `"on-failure"` — capture when a step or test fails (default)
 * - `"every-step"` — capture after every action AND on failure
 */
export type ScreenshotMode = "off" | "on-failure" | "every-step";

/**
 * What triggered a screenshot capture.
 *
 * - `"step"` — post-action capture in every-step mode
 * - `"failure"` — automatic capture on action or assertion failure
 * - `"manual"` — explicit call to `page.captureScreenshot()`
 */
export type ScreenshotTrigger = "step" | "failure" | "manual";

/** A screenshot captured into the evidence stream. */
export interface ScreenshotEntry {
  /** Sequential number within this evidence session (1-based). */
  seq: number;
  /** Wall-clock ISO timestamp at capture time. */
  ts: string;
  /** Human-readable label (the action or assertion that triggered the capture). */
  label: string;
  /** What triggered this capture. */
  trigger: ScreenshotTrigger;
  /** Artifact ID when `ctx.saveArtifact` is available (SDK ≥ 0.13). */
  artifactId?: string;
  /** File path when falling back to direct file write. */
  path?: string;
}

/**
 * Screenshot capture options for the shared evidence session.
 *
 * The `shoot` delegate performs the actual I/O (screenshot + artifact save +
 * `ctx.event()` emission); {@link EvidenceSession.captureShot} handles the
 * mode / trigger policy, sequencing, and accumulation of entries.
 */
export interface EvidenceScreenshotOptions {
  /** Policy: which triggers result in a capture. */
  mode: ScreenshotMode;
  /**
   * I/O delegate — takes the screenshot, saves the artifact, and emits
   * the `browser:screenshot` evidence event. Returns an artifact reference
   * for {@link ScreenshotEntry}. Called only when the mode/trigger policy allows.
   *
   * @param filename — suggested filename: `[FAIL-]NNN-label-ts.png`
   * @param label — human label for the action/assertion
   * @param trigger — what triggered this capture
   */
  shoot: (
    filename: string,
    label: string,
    trigger: ScreenshotTrigger,
  ) => Promise<{ artifactId?: string; path?: string }>;
}

/** A single header as CDP's `Fetch.fulfillRequest` expects it. */
interface HeaderEntry {
  name: string;
  value: string;
}

/**
 * A request-mock rule. Matching requests are fulfilled with a canned response;
 * everything else is continued untouched.
 */
export interface MockRule {
  /**
   * Match the request URL. A string matches by substring (`url.includes(...)`);
   * a `RegExp` matches by `test(url)`.
   */
  url: string | RegExp;
  /** Restrict to a single HTTP method (case-insensitive). Omit to match any. */
  method?: string;
  /** Response status code. @default 200 */
  status?: number;
  /** Extra response headers. */
  headers?: Record<string, string>;
  /**
   * Response body. A string is sent verbatim; any other value is
   * `JSON.stringify`-ed. The `content-type` is inferred (JSON vs plain text)
   * unless `contentType` is set.
   */
  body?: unknown;
  /** Explicit `content-type` header. Overrides the inferred value. */
  contentType?: string;
}

/** Geolocation override. */
export interface GeolocationOverride {
  latitude: number;
  longitude: number;
  /** Accuracy in meters. @default 0 (mirrors Puppeteer's `setGeolocation`). */
  accuracy?: number;
}

/** Viewport / device-metrics override (owned solely by Glubean — see guardrail ①). */
export interface ViewportOverride {
  width: number;
  height: number;
  /** @default 1 */
  deviceScaleFactor?: number;
  /** @default false */
  mobile?: boolean;
}

/**
 * Environment emulation applied on the shared evidence session.
 *
 * Timezone, geolocation, and user agent are pure overrides with no Puppeteer
 * conflict. Viewport is special: see guardrail ① — do **not** also call
 * `page.setViewport()`, it will race with this override.
 */
export interface EmulationOptions {
  /** IANA timezone id, e.g. `"America/New_York"`. */
  timezone?: string;
  /** Geolocation override. */
  geolocation?: GeolocationOverride;
  /** Viewport / device metrics. Glubean becomes the sole viewport owner. */
  viewport?: ViewportOverride;
  /** User-agent string override (`Emulation.setUserAgentOverride`). */
  userAgent?: string;
}

/**
 * A cookie as accepted by {@link EvidenceSession.attach}'s `storageState.cookies`
 * and returned by {@link EvidenceSession.captureStorageState}. Mirrors the CDP
 * `Network.CookieParam` / `Network.Cookie` shapes closely enough to round-trip:
 * a captured cookie can be fed straight back in as an applied one.
 */
export interface StorageCookie {
  name: string;
  value: string;
  /** Either `domain` or `url` must be resolvable for CDP to place the cookie. */
  domain?: string;
  path?: string;
  url?: string;
  /** Unix time in seconds, or `-1` for a session cookie. */
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

/**
 * Cookies + localStorage for one page — a thin "login once, reuse the
 * session" primitive (à la Playwright's `storageState`). Cookies apply via
 * CDP `Network.setCookies`; localStorage applies via Puppeteer's own
 * `page.evaluateOnNewDocument()` (see guardrail ③) so it is present before
 * the page's own scripts run on every navigation of this page.
 */
export interface StorageState {
  cookies?: StorageCookie[];
  /** Key/value pairs seeded into `localStorage` on every new document. */
  localStorage?: Record<string, string>;
}

/** Lifecycle state of a browser download (mirrors CDP `Browser.downloadProgress.state`). */
export type DownloadState = "inProgress" | "completed" | "canceled";

/**
 * A browser download captured via CDP `Browser.downloadWillBegin` /
 * `Browser.downloadProgress`.
 */
export interface DownloadEntry {
  /** CDP-assigned globally-unique download id. */
  guid: string;
  /** URL the download was initiated from (may be `data:`/`blob:`). */
  url: string;
  /** Filename suggested by the server/anchor at download start. */
  suggestedFilename: string;
  /**
   * Best-effort on-disk path: `${dir}/${suggestedFilename}`. Exact only when
   * Chrome didn't have to de-duplicate a filename collision in `dir` — see
   * the module doc's Downloads note.
   */
  path: string;
}

/** Options wiring the shared session's download capture. */
export interface DownloadOptions {
  /** Directory downloads are saved to. Must already exist — the caller creates it. */
  dir: string;
  /**
   * Called on every state transition (`inProgress` fires once per progress
   * tick — usually more than once per download; `completed`/`canceled` fire
   * exactly once). Mainly for evidence emission; {@link EvidenceSession.waitForDownload}
   * is the ergonomic way to correlate a triggering action with its result.
   */
  onDownload?: (entry: DownloadEntry, state: DownloadState) => void;
}

/** Options for {@link EvidenceSession.attach}. */
export interface EvidenceSessionOptions {
  /**
   * Network-trace callback (`ctx.trace`). When omitted, the `Network` domain
   * tracer is not attached.
   */
  trace?: TraceFn;
  /** Network-trace filter configuration. Ignored when `trace` is omitted. */
  network?: Pick<NetworkTracerOptions, "include" | "excludePaths" | "filter">;
  /** Request-mock rules. When non-empty, the `Fetch` domain is enabled (guardrail ②). */
  mocks?: MockRule[];
  /** Environment emulation (timezone / geolocation / viewport / user agent). */
  emulate?: EmulationOptions;
  /**
   * Cookies / localStorage to restore before the page's first script runs
   * (`storageState.cookies` via `Network.setCookies`, `storageState.localStorage`
   * via Puppeteer's `page.evaluateOnNewDocument()` — see guardrail ③).
   * Capture the current state with {@link EvidenceSession.captureStorageState}.
   */
  storageState?: StorageState;
  /**
   * Screenshot capture policy and I/O delegate.
   *
   * When provided, {@link EvidenceSession.captureShot} becomes active and will
   * call `screenshots.shoot` based on the configured mode and trigger.
   * Omit (or set `mode: "off"`) to disable all automatic screenshot capture.
   */
  screenshots?: EvidenceScreenshotOptions;
  /**
   * Download capture (`Browser.setDownloadBehavior` + `downloadWillBegin`/
   * `downloadProgress`). When provided, every download on this page is
   * allowed (not blocked) and reported via `onDownload` / {@link EvidenceSession.waitForDownload}.
   */
  downloads?: DownloadOptions;
}

/** A single CDP call: `{ method, params }`. Kept pure for testing. */
export interface CdpCall {
  method: string;
  params?: Record<string, unknown>;
}

// ── Pure helpers (exported for testing) ───────────────────────────────

/** @internal Does `rule` match the given request? */
export function matchMock(
  rule: MockRule,
  req: { url: string; method: string },
): boolean {
  if (rule.method && rule.method.toUpperCase() !== req.method.toUpperCase()) {
    return false;
  }
  if (typeof rule.url === "string") return req.url.includes(rule.url);
  // Test against a freshly-constructed clone that carries the SAME flags as
  // `rule.url`, including `g`/`y`: a global/sticky regex carries `lastIndex`
  // state, so `.test()` on the caller's own object would flip-flop matches
  // for the same URL across repeated requests (and would mutate the caller's
  // regex). A same-flags clone fixes that statelessness — it always starts
  // at `lastIndex: 0` and is discarded after this call, so no state ever
  // crosses requests or leaks back into `rule.url`.
  //
  // Earlier this also *stripped* `g`/`y` on the clone, which went further
  // than the statelessness fix required: dropping `y` silently discards a
  // sticky regex's anchoring semantics — `.test()` on a `/y` regex only
  // matches when the pattern occurs starting exactly at `lastIndex` (0 here,
  // i.e. the start of the string), whereas a plain (non-sticky) regex
  // matches anywhere in the string. Stripping `y` therefore turned an
  // anchored mock pattern into an unanchored substring search, which could
  // make a sticky mock rule match URLs it was never meant to (GLU-73).
  // Preserving the original flags on the clone keeps `.test()` behaving
  // exactly as it would on a fresh copy of the caller's own regex.
  const clone = new RegExp(rule.url.source, rule.url.flags);
  return clone.test(req.url);
}

/** @internal Find the first matching mock rule, or `undefined`. */
export function findMock(
  mocks: readonly MockRule[],
  req: { url: string; method: string },
): MockRule | undefined {
  return mocks.find((m) => matchMock(m, req));
}

/**
 * @internal Build `Fetch.fulfillRequest` params from a rule.
 *
 * The body is always base64-encoded (as CDP requires). Content-type is inferred
 * from the body kind unless `rule.contentType` is set. User headers win over the
 * inferred content-type.
 */
export function buildFulfillParams(
  rule: MockRule,
  requestId: string,
): {
  requestId: string;
  responseCode: number;
  responseHeaders: HeaderEntry[];
  body: string;
} {
  let bodyStr = "";
  let inferredType: string | undefined;
  if (rule.body !== undefined) {
    if (typeof rule.body === "string") {
      bodyStr = rule.body;
      inferredType = "text/plain; charset=utf-8";
    } else {
      bodyStr = JSON.stringify(rule.body);
      inferredType = "application/json; charset=utf-8";
    }
  }

  const headerMap = new Map<string, string>();
  const contentType = rule.contentType ?? inferredType;
  if (contentType !== undefined) headerMap.set("content-type", contentType);
  // User headers win over the inferred content-type (case-insensitive keys).
  for (const [name, value] of Object.entries(rule.headers ?? {})) {
    headerMap.set(name.toLowerCase(), value);
  }

  return {
    requestId,
    responseCode: rule.status ?? 200,
    responseHeaders: [...headerMap].map(([name, value]) => ({ name, value })),
    body: Buffer.from(bodyStr, "utf8").toString("base64"),
  };
}

/**
 * @internal Build the ordered list of `Emulation.*` CDP calls.
 *
 * Timezone, geolocation, and user agent come first (order-independent among
 * themselves); the viewport override is applied **last** (guardrail ①) so it
 * is the final word on device metrics at setup time.
 */
export function buildEmulationCalls(emulate: EmulationOptions): CdpCall[] {
  const calls: CdpCall[] = [];
  if (emulate.timezone !== undefined) {
    calls.push({
      method: "Emulation.setTimezoneOverride",
      params: { timezoneId: emulate.timezone },
    });
  }
  if (emulate.geolocation) {
    const { latitude, longitude, accuracy } = emulate.geolocation;
    calls.push({
      method: "Emulation.setGeolocationOverride",
      params: { latitude, longitude, accuracy: accuracy ?? 0 },
    });
  }
  if (emulate.userAgent !== undefined) {
    calls.push({
      method: "Emulation.setUserAgentOverride",
      params: { userAgent: emulate.userAgent },
    });
  }
  if (emulate.viewport) {
    const { width, height, deviceScaleFactor, mobile } = emulate.viewport;
    calls.push({
      method: "Emulation.setDeviceMetricsOverride",
      params: {
        width,
        height,
        deviceScaleFactor: deviceScaleFactor ?? 1,
        mobile: mobile ?? false,
      },
    });
  }
  return calls;
}

/**
 * @internal Build `Network.setCookies` params from `storageState.cookies`.
 * Returns `undefined` when there is nothing to set (caller skips the call).
 */
export function buildSetCookiesParams(
  cookies: StorageCookie[] | undefined,
): { cookies: StorageCookie[] } | undefined {
  if (!cookies || cookies.length === 0) return undefined;
  return { cookies };
}

/**
 * @internal Replace `page[method]` with a guard, returning a restore function.
 *
 * `shouldBlock` decides, per call arguments, whether to throw the guard error.
 * Blocked calls throw synchronously; allowed calls fall through to the original
 * method (or resolve to `undefined` if there was none). Used to enforce
 * guardrails ① (viewport) and ② (Fetch interception).
 */
export function guardPageMethod(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any,
  method: string,
  message: string,
  shouldBlock: (args: unknown[]) => boolean,
): () => void {
  const hadOwn = Object.prototype.hasOwnProperty.call(page, method);
  const previous = page[method];
  const original = typeof previous === "function"
    ? previous.bind(page)
    : undefined;

  page[method] = (...args: unknown[]) => {
    if (shouldBlock(args)) throw new Error(message);
    return original ? original(...args) : Promise.resolve(undefined);
  };

  return () => {
    if (hadOwn) page[method] = previous;
    else delete page[method];
  };
}

// ── EvidenceSession ───────────────────────────────────────────────────

/**
 * A single self-opened CDP session that hosts every CDP-backed evidence
 * capability for one page. Create with {@link EvidenceSession.attach}; release
 * with {@link EvidenceSession.detach}.
 */
export class EvidenceSession {
  private readonly _cdp: CDPSession;
  private readonly _cleanups: Array<() => void | Promise<void>> = [];
  private _detached = false;

  // ── Screenshot state ──────────────────────────────────────────────
  private _screenshotOpts: EvidenceScreenshotOptions | undefined;
  private _screenshotSeq = 0;
  private _screenshotLog: ScreenshotEntry[] = [];

  // ── Download state ───────────────────────────────────────────────
  private _downloadsEnabled = false;
  private _downloadDir: string | undefined;
  private _onDownload: DownloadOptions["onDownload"];
  /**
   * Frame ids owned by THIS page's target. `Browser.setDownloadBehavior`'s
   * events are browser-context-global — every session that turned events on
   * receives every download in the context. We only record downloads whose
   * originating `frameId` belongs to this page, so two instrumented pages
   * sharing one Chrome never cross-observe each other's downloads.
   */
  private _ownedFrames = new Set<string>();
  /**
   * True only once the initial `Page.getFrameTree` seeded {@link _ownedFrames}.
   * The frame filter engages ONLY when this is set — otherwise we accept all
   * download events (fallback mode). Without this flag, a later
   * `Page.frameAttached` would grow `_ownedFrames` from empty to non-empty and
   * silently flip fallback mode into a PARTIAL filter that drops the page's own
   * top-frame downloads (codex R2 P2).
   */
  private _frameTreeSeeded = false;
  private _pendingDownloads = new Map<
    string,
    { url: string; suggestedFilename: string }
  >();
  private _downloadWaiters: Array<{
    resolve: (entry: DownloadEntry) => void;
    reject: (err: Error) => void;
  }> = [];

  private constructor(cdp: CDPSession) {
    this._cdp = cdp;
  }

  /** The underlying CDP session, for advanced/raw use. */
  get cdp(): CDPSession {
    return this._cdp;
  }

  /**
   * All screenshots captured into this evidence session, in order.
   *
   * Each entry carries `seq`, `ts`, `label`, `trigger`, and an artifact
   * reference (`artifactId` or `path`). The list is empty when no screenshot
   * has been captured yet or when `screenshots.mode` is `"off"`.
   */
  get screenshots(): readonly ScreenshotEntry[] {
    return this._screenshotLog;
  }

  /**
   * Capture a screenshot into the evidence stream, subject to the configured
   * {@link ScreenshotMode} and the `trigger` argument.
   *
   * | mode          | "step" trigger | "failure" trigger | "manual" trigger |
   * |---------------|----------------|-------------------|------------------|
   * | "off"         | skip           | skip              | skip             |
   * | "on-failure"  | skip           | capture           | capture          |
   * | "every-step"  | capture        | capture           | capture          |
   *
   * Always best-effort: errors from the I/O delegate are silently swallowed
   * so a broken page state never masks the real test error.
   *
   * Does nothing when no `screenshots` option was passed to {@link attach}.
   */
  async captureShot(label: string, trigger: ScreenshotTrigger): Promise<void> {
    const opts = this._screenshotOpts;
    if (!opts) return;
    // "off" blocks automatic triggers but manual checkpoints always fire.
    if (opts.mode === "off" && trigger !== "manual") return;
    if (opts.mode === "on-failure" && trigger === "step") return;

    this._screenshotSeq++;
    const seq = this._screenshotSeq;
    const ts = new Date().toISOString();
    const sanitized = label.replace(/[^a-z0-9_-]/gi, "_").slice(0, 60);
    const tsCompact = ts.replace(/[:.]/g, "").slice(0, 15);
    const prefix = trigger === "failure" ? "FAIL-" : "";
    const filename = `${prefix}${String(seq).padStart(3, "0")}-${sanitized}-${tsCompact}.png`;

    try {
      const ref = await opts.shoot(filename, label, trigger);
      this._screenshotLog.push({ seq, ts, label, trigger, ...ref });
    } catch {
      // best-effort: page may be in a broken state
    }
  }

  /**
   * Open one CDP session on `page` and wire up the requested capabilities:
   * Network trace, Fetch mock (guardrail ②), Emulation (guardrail ① for
   * viewport), and storage state (cookies + localStorage). Capabilities are
   * only enabled when their config is present, so a page with no mocks never
   * enables `Fetch` and leaves the user's own request interception untouched.
   */
  static async attach(
    page: Page,
    options: EvidenceSessionOptions,
  ): Promise<EvidenceSession> {
    const cdp = await page.createCDPSession();
    const session = new EvidenceSession(cdp);
    // Wire screenshot options (no CDP domain — just stores the delegate).
    // Store opts even when mode is "off" so that captureShot can still
    // honour explicit manual checkpoints (captureShot itself gates auto
    // triggers via `if (mode === "off" && trigger !== "manual") return`).
    if (options.screenshots) {
      session._screenshotOpts = options.screenshots;
    }
    try {
      // 1. Network trace.
      if (options.trace) {
        const removeNetwork = await attachNetworkTracer(cdp, {
          trace: options.trace,
          include: options.network?.include,
          excludePaths: options.network?.excludePaths,
          filter: options.network?.filter,
        });
        session._cleanups.push(removeNetwork);
      }

      // 2. Fetch mock — guardrail ②: Glubean owns Fetch, block user interception.
      const mocks = options.mocks;
      if (mocks && mocks.length > 0) {
        await session._installMocks(page, mocks);
      }

      // 3. Emulation (timezone / geolocation / user agent) + viewport last (guardrail ①).
      if (options.emulate) {
        for (const call of buildEmulationCalls(options.emulate)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await cdp.send(call.method as any, call.params as any);
        }
        if (options.emulate.viewport) {
          session._guardViewport(page);
        }
      }

      // 4. Storage state — cookies + localStorage restored before the page's
      // first script runs. Order-independent from the other capabilities.
      if (options.storageState) {
        await session._applyStorageState(page, options.storageState);
      }

      // 5. Downloads — see the module doc's Downloads note. Order-independent.
      if (options.downloads) {
        await session._enableDownloads(options.downloads);
      }
    } catch (err) {
      // Roll back any partial wiring so we never leak a half-open session.
      await session.detach();
      throw err;
    }
    return session;
  }

  private async _installMocks(page: Page, mocks: MockRule[]): Promise<void> {
    // Guardrail ②: block the user from enabling Puppeteer request interception
    // while our Fetch mock is active (double-fulfill conflict). Disabling
    // (`false`) is allowed through to the original.
    const restoreInterception = guardPageMethod(
      page,
      "setRequestInterception",
      "Glubean request mocking is active on this page: do not call " +
        "page.setRequestInterception(true) — it conflicts with the mock's " +
        "Fetch handler. Remove the `mock` option to manage interception yourself.",
      (args) => args[0] === true,
    );
    this._cleanups.push(restoreInterception);

    // Intercept every request at the Request stage; match in JS. Mocked
    // requests are fulfilled, everything else is continued untouched — so the
    // Network tracer still observes real responses.
    await this._cdp.send("Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Request" }],
    });

    const onPaused = (event: {
      requestId: string;
      request: { url: string; method: string };
    }): void => {
      const rule = findMock(mocks, {
        url: event.request.url,
        method: event.request.method,
      });
      const done = rule
        ? this._cdp.send(
          "Fetch.fulfillRequest",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          buildFulfillParams(rule, event.requestId) as any,
        )
        : this._cdp.send("Fetch.continueRequest", {
          requestId: event.requestId,
        });
      // The request is gone if the page navigated away mid-flight — ignore.
      done.catch(() => {});
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this._cdp.on("Fetch.requestPaused", onPaused as any);
    this._cleanups.push(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this._cdp.off("Fetch.requestPaused", onPaused as any);
    });
  }

  private async _applyStorageState(
    page: Page,
    state: StorageState,
  ): Promise<void> {
    // Cookies are browser-context scoped in CDP, so our auxiliary session
    // sets them fine (`Network.setCookies` isn't tied to a particular
    // DevTools session/target the way frame-lifecycle hooks are).
    const cookieParams = buildSetCookiesParams(state.cookies);
    if (cookieParams) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await this._cdp.send("Network.setCookies", cookieParams as any);
    }
    // localStorage seeding, in contrast, MUST go through Puppeteer's own
    // page.evaluateOnNewDocument() — sending the equivalent raw
    // `Page.addScriptToEvaluateOnNewDocument` on our *auxiliary*
    // `page.createCDPSession()` session silently registers (no error, a
    // real `identifier` comes back) but never actually fires on subsequent
    // navigations. Verified empirically (spike script) against puppeteer-core
    // ^24/^25: only the session Puppeteer itself uses for the page's own
    // frame-lifecycle bookkeeping gets its new-document scripts run — a
    // second, independently-attached session's registration is a no-op.
    // Puppeteer's own API owns that session, so route through it here.
    if (state.localStorage && Object.keys(state.localStorage).length > 0) {
      const entries = state.localStorage;
      await page.evaluateOnNewDocument((seed: Record<string, string>) => {
        for (const [k, v] of Object.entries(seed)) {
          try {
            localStorage.setItem(k, v);
          } catch {
            // best-effort — e.g. storage quota exceeded
          }
        }
      }, entries);
    }
  }

  /**
   * @internal Wire `Browser.setDownloadBehavior` (`eventsEnabled: true`) plus
   * the `downloadWillBegin` / `downloadProgress` listeners on this session.
   * See the module doc's Downloads note for why `Browser.*` (not the
   * deprecated `Page.*` pair) and why it works on an auxiliary session.
   *
   * `Browser.*` download events are browser-context-global, so we also enable
   * the `Page` domain and track this target's frame ids, then only record
   * downloads originating from a frame we own — two instrumented pages in one
   * Chrome must not cross-observe each other's downloads.
   */
  private async _enableDownloads(opts: DownloadOptions): Promise<void> {
    this._downloadsEnabled = true;
    this._downloadDir = opts.dir;
    this._onDownload = opts.onDownload;

    // Seed + track the frame ids owned by this page's target so download-event
    // attribution is page-scoped (Browser.* events are context-global). Page
    // domain on our auxiliary session is independent of Puppeteer's own session.
    await this._cdp.send("Page.enable");
    try {
      const { frameTree } = (await this._cdp.send("Page.getFrameTree")) as {
        frameTree: { frame: { id: string }; childFrames?: unknown[] };
      };
      const walk = (node: { frame: { id: string }; childFrames?: unknown[] }): void => {
        this._ownedFrames.add(node.frame.id);
        for (const child of node.childFrames ?? []) {
          walk(child as { frame: { id: string }; childFrames?: unknown[] });
        }
      };
      walk(frameTree);
      this._frameTreeSeeded = true;
    } catch {
      // best-effort: if the frame tree can't be read, fall back to accepting
      // all download events (single-page runs are unaffected; the cross-page
      // guard just degrades to off rather than erroring).
    }
    const onFrameAttached = (e: { frameId: string }): void => {
      this._ownedFrames.add(e.frameId);
    };
    const onFrameDetached = (e: { frameId: string }): void => {
      this._ownedFrames.delete(e.frameId);
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this._cdp.on("Page.frameAttached", onFrameAttached as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this._cdp.on("Page.frameDetached", onFrameDetached as any);

    await this._cdp.send("Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: opts.dir,
      eventsEnabled: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const onWillBegin = (event: {
      guid: string;
      url: string;
      suggestedFilename: string;
      frameId?: string;
    }): void => {
      // Only record downloads from a frame this page owns. The filter engages
      // ONLY when the initial frame tree seeded successfully (_frameTreeSeeded)
      // — otherwise we accept all events (fallback), and later frameAttached
      // ids must NOT flip that into a partial filter (codex R2 P2). An event
      // with no frameId is also accepted rather than silently dropped.
      if (
        this._frameTreeSeeded &&
        event.frameId !== undefined &&
        !this._ownedFrames.has(event.frameId)
      ) {
        return;
      }
      this._pendingDownloads.set(event.guid, {
        url: event.url,
        suggestedFilename: event.suggestedFilename,
      });
    };

    const onProgress = (event: {
      guid: string;
      state: DownloadState;
    }): void => {
      // Unknown guid = a download we didn't record in onWillBegin (either it
      // began before attach, or it belongs to another page — see the frame
      // filter above). Ignore it.
      const pending = this._pendingDownloads.get(event.guid);
      if (!pending) return;

      const entry: DownloadEntry = {
        guid: event.guid,
        url: pending.url,
        suggestedFilename: pending.suggestedFilename,
        path: `${this._downloadDir}/${pending.suggestedFilename}`,
      };

      if (event.state === "inProgress") {
        this._notifyDownload(entry, "inProgress");
        return;
      }

      this._pendingDownloads.delete(event.guid);
      // Emit evidence for EVERY terminal download (best-effort, isolated from
      // the waiter state machine — a throwing callback must not wedge it).
      this._notifyDownload(entry, event.state);

      // Hand the terminal result to the next waiter (FIFO). A terminal
      // download with no waiter is untargeted — its evidence is already
      // emitted, so we simply drop it (never buffer it to satisfy a LATER,
      // unrelated waitForDownload — that would silently mis-scope the wait).
      const waiter = this._downloadWaiters.shift();
      if (!waiter) return;
      if (event.state === "completed") {
        waiter.resolve(entry);
      } else {
        waiter.reject(
          new Error(
            `waitForDownload: download "${entry.suggestedFilename}" (${entry.guid}) was canceled`,
          ),
        );
      }
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this._cdp.on("Browser.downloadWillBegin", onWillBegin as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this._cdp.on("Browser.downloadProgress", onProgress as any);
    this._cleanups.push(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this._cdp.off("Browser.downloadWillBegin", onWillBegin as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this._cdp.off("Browser.downloadProgress", onProgress as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this._cdp.off("Page.frameAttached", onFrameAttached as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this._cdp.off("Page.frameDetached", onFrameDetached as any);
      // Mark disabled + reject any still-pending waiters so nothing hangs
      // until its own timeout past detach, and a post-detach call fails fast.
      this._downloadsEnabled = false;
      this._frameTreeSeeded = false;
      this._pendingDownloads.clear();
      this._ownedFrames.clear();
      const waiting = this._downloadWaiters.splice(0, this._downloadWaiters.length);
      for (const w of waiting) {
        w.reject(new Error("waitForDownload: evidence session detached while waiting"));
      }
    });
  }

  /** @internal Best-effort onDownload callback — never let it wedge the waiter machine. */
  private _notifyDownload(entry: DownloadEntry, state: DownloadState): void {
    try {
      this._onDownload?.(entry, state);
    } catch {
      // best-effort — a throwing evidence callback must not break download waits
    }
  }

  /**
   * Wait for the NEXT download (one that completes after this call) to finish,
   * and resolve with its metadata. Register the wait *before* triggering the
   * action that starts the download — `GlubeanPage.waitForDownload(action)` in
   * `page.ts` does exactly this and is the ergonomic wrapper most callers
   * should use instead of this lower-level method.
   *
   * Rejects if the next download is canceled, after `timeoutMs`, if `signal`
   * aborts (e.g. the triggering action threw), or if the session has detached.
   * Does **not** resolve from downloads that already completed before the call —
   * each wait is scoped to a fresh, future download.
   */
  waitForDownload(timeoutMs: number, signal?: AbortSignal): Promise<DownloadEntry> {
    if (!this._downloadsEnabled) {
      return Promise.reject(
        new Error("waitForDownload: downloads are not enabled on this page"),
      );
    }
    if (signal?.aborted) {
      return Promise.reject(new Error("waitForDownload: aborted before it started"));
    }
    return new Promise<DownloadEntry>((resolve, reject) => {
      // Single teardown for EVERY exit path (timeout, abort, resolve, reject)
      // so the timer, the waiter registration, and the abort listener are all
      // always released — no listener leak on the timeout path (codex R2 P3).
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const idx = this._downloadWaiters.indexOf(waiter);
        if (idx >= 0) this._downloadWaiters.splice(idx, 1);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(`waitForDownload: no download completed after ${timeoutMs}ms`),
        );
      }, timeoutMs);
      const onAbort = (): void => {
        cleanup();
        reject(new Error("waitForDownload: aborted (triggering action failed)"));
      };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      const waiter = {
        resolve: (entry: DownloadEntry) => {
          cleanup();
          resolve(entry);
        },
        reject: (err: Error) => {
          cleanup();
          reject(err);
        },
      };
      this._downloadWaiters.push(waiter);
    });
  }

  /**
   * Capture the current page's cookies + localStorage as a {@link StorageState}
   * snapshot — the counterpart to {@link EvidenceSessionOptions.storageState}.
   * Cookies are scoped to the page's current URL (`Network.getCookies`), not
   * every cookie the browser holds, so unrelated tabs/origins never leak in.
   *
   * @example
   * ```ts
   * await page.goto("/login");
   * // ... perform login ...
   * const state = await page.getStorageState();
   * // Reuse on a fresh page to skip the login flow:
   * const chrome2 = browser({ launch: true, storageState: state });
   * ```
   */
  async captureStorageState(page: Page): Promise<StorageState> {
    const { cookies } = (await this._cdp.send("Network.getCookies", {
      urls: [page.url()],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)) as { cookies: StorageCookie[] };

    const localStorage = await page.evaluate(() => {
      const out: Record<string, string> = {};
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ls = (globalThis as any).localStorage;
        for (let i = 0; i < ls.length; i++) {
          const key = ls.key(i);
          if (key !== null) out[key] = ls.getItem(key) ?? "";
        }
      } catch {
        // localStorage may be inaccessible (e.g. sandboxed/about:blank) — best-effort.
      }
      return out;
    });

    return {
      cookies: (cookies ?? []).map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expires,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite,
      })),
      localStorage,
    };
  }

  private _guardViewport(page: Page): void {
    // Guardrail ①: Glubean owns the viewport via Emulation on this session.
    // Block page.setViewport() so it can't clobber the override last-wins.
    const restore = guardPageMethod(
      page,
      "setViewport",
      "Glubean owns the viewport on this page (via the `emulate.viewport` " +
        "option): do not call page.setViewport() — the two overrides race " +
        "last-wins. Configure the viewport through browser({ emulate }) instead.",
      () => true,
    );
    this._cleanups.push(restore);
  }

  /**
   * Remove all listeners/overrides, restore guarded page methods, and detach
   * the CDP session. Idempotent and best-effort — safe to call after the page
   * has closed.
   */
  async detach(): Promise<void> {
    if (this._detached) return;
    this._detached = true;

    // Run cleanups in reverse (LIFO) so guards/overrides unwind in order.
    for (const cleanup of this._cleanups.reverse()) {
      try {
        await cleanup();
      } catch {
        // best-effort — page/session may already be gone
      }
    }
    this._cleanups.length = 0;

    try {
      await this._cdp.detach();
    } catch {
      // session may already be closed
    }
  }
}
