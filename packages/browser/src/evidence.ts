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
 * - **Emulation** (`Emulation` domain) — timezone / geolocation / viewport.
 *
 * The keystone spike disproved the "Fetch is near-exclusive" hypothesis: a
 * self-opened session running `Fetch.enable`/`fulfillRequest` is stable **as
 * long as the user has not enabled Puppeteer's own request interception**.
 * Two coexistence hazards remain, each handled by a guardrail below:
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
 * @module evidence
 */

import type { CDPSession, Page } from "puppeteer-core";
import {
  attachNetworkTracer,
  type NetworkTracerOptions,
  type TraceFn,
} from "./network.js";

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
 * Timezone and geolocation are pure overrides with no Puppeteer conflict.
 * Viewport is special: see guardrail ① — do **not** also call
 * `page.setViewport()`, it will race with this override.
 */
export interface EmulationOptions {
  /** IANA timezone id, e.g. `"America/New_York"`. */
  timezone?: string;
  /** Geolocation override. */
  geolocation?: GeolocationOverride;
  /** Viewport / device metrics. Glubean becomes the sole viewport owner. */
  viewport?: ViewportOverride;
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
  /** Environment emulation (timezone / geolocation / viewport). */
  emulate?: EmulationOptions;
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
  // Test against a stateless clone: a user-supplied global/sticky regex
  // (`/g`, `/y`) carries `lastIndex` state, so `.test()` on the original would
  // flip-flop matches for the same URL across repeated requests (and would also
  // mutate the caller's regex). Strip `g`/`y` on a copy to keep matching pure.
  const stateless = new RegExp(
    rule.url.source,
    rule.url.flags.replace(/[gy]/g, ""),
  );
  return stateless.test(req.url);
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
 * Timezone and geolocation come first; the viewport override is applied **last**
 * (guardrail ①) so it is the final word on device metrics at setup time.
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

  private constructor(cdp: CDPSession) {
    this._cdp = cdp;
  }

  /** The underlying CDP session, for advanced/raw use. */
  get cdp(): CDPSession {
    return this._cdp;
  }

  /**
   * Open one CDP session on `page` and wire up the requested capabilities:
   * Network trace, Fetch mock (guardrail ②), and Emulation (guardrail ① for
   * viewport). Capabilities are only enabled when their config is present, so a
   * page with no mocks never enables `Fetch` and leaves the user's own request
   * interception untouched.
   */
  static async attach(
    page: Page,
    options: EvidenceSessionOptions,
  ): Promise<EvidenceSession> {
    const cdp = await page.createCDPSession();
    const session = new EvidenceSession(cdp);
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

      // 3. Emulation (timezone / geolocation) + viewport last (guardrail ①).
      if (options.emulate) {
        for (const call of buildEmulationCalls(options.emulate)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await cdp.send(call.method as any, call.params as any);
        }
        if (options.emulate.viewport) {
          session._guardViewport(page);
        }
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
