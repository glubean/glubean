/**
 * CDP Network domain listener for auto-tracing in-page requests.
 *
 * Intercepts XHR, fetch, and document requests inside the browser page and
 * emits them as Glubean trace events so they appear in the same timeline as
 * `ctx.http` calls.
 *
 * @module network
 */

import type { CDPSession, Page } from "puppeteer-core";

/** Callback shape matching `ctx.trace()`. */
export type TraceFn = (trace: {
  protocol: "http";
  target: string;
  durationMs: number;
  ok: boolean;
  name?: string;
  /** @deprecated Use target/metadata instead */
  method: string;
  /** @deprecated Use target/metadata instead */
  url: string;
  status: number;
  /** @deprecated Use durationMs instead */
  duration: number;
  requestBody?: unknown;
  responseBody?: unknown;
}) => void;

const SKIP_PROTOCOLS = ["data:", "chrome-extension:", "devtools:", "blob:"];

/** Default content-type prefixes to include in traces. */
const DEFAULT_INCLUDE = ["application/json", "text/html"];

/** Default URL paths to skip (browser-initiated noise). */
const DEFAULT_EXCLUDE_PATHS = [
  "/favicon.ico",
  "/favicon.png",
  "/apple-touch-icon.png",
  "/apple-touch-icon-precomposed.png",
];

/** Max response body size to capture (bytes). Larger bodies are truncated. */
const MAX_BODY_BYTES = 64 * 1024;

/** @internal Exported for testing. */
export function shouldSkipProtocol(url: string): boolean {
  for (const proto of SKIP_PROTOCOLS) {
    if (url.startsWith(proto)) return true;
  }
  return false;
}

/** @internal Exported for testing. */
export function shouldSkipPath(url: string, excludePaths: string[]): boolean {
  try {
    const pathname = new URL(url).pathname;
    for (const p of excludePaths) {
      if (pathname === p) return true;
    }
  } catch {
    // invalid URL, don't skip
  }
  return false;
}

/** @internal Exported for testing. */
export function shouldInclude(
  contentType: string,
  include: string[],
): boolean {
  const ct = contentType.toLowerCase();
  for (const prefix of include) {
    if (ct.startsWith(prefix)) return true;
  }
  return false;
}

/** Filter predicate for network requests. */
export type NetworkFilter = (req: {
  url: string;
  contentType: string;
  status: number;
}) => boolean;

export interface NetworkTracerOptions {
  trace: TraceFn;
  /**
   * Content-type prefixes to include. Ignored when `filter` is provided.
   * @default ["application/json", "text/html"]
   */
  include?: string[];
  /**
   * URL paths to skip. Pass `[]` to disable default exclusions.
   * @default ["/favicon.ico", "/favicon.png", "/apple-touch-icon.png", "/apple-touch-icon-precomposed.png"]
   */
  excludePaths?: string[];
  /** Custom predicate. Overrides `include` and `excludePaths` when provided. */
  filter?: NetworkFilter;
}

/** Pending request state stored between CDP events. */
interface PendingRequest {
  method: string;
  url: string;
  startMs: number;
  requestBody?: string;
  // Filled on responseReceived; trace emitted on loadingFinished.
  status?: number;
  contentType?: string;
  responseTimestamp?: number;
}

/**
 * Attach a CDP Network listener to the page that emits Glubean trace events
 * for every in-page network request.
 *
 * Returns a cleanup function that detaches the listener.
 */
export async function attachNetworkTracer(
  page: Page,
  options: NetworkTracerOptions,
): Promise<() => Promise<void>> {
  const { trace, filter, include = DEFAULT_INCLUDE, excludePaths = DEFAULT_EXCLUDE_PATHS } = options;
  const cdp: CDPSession = await page.createCDPSession();
  await cdp.send("Network.enable");

  const pending = new Map<string, PendingRequest>();

  // ── requestWillBeSent: capture request info ─────────────────────────
  const onRequestWillBeSent = (params: {
    requestId: string;
    request: { method: string; url: string; postData?: string };
    timestamp: number;
  }) => {
    pending.set(params.requestId, {
      method: params.request.method,
      url: params.request.url,
      startMs: params.timestamp * 1000,
      requestBody: params.request.postData,
    });
  };

  // ── responseReceived: capture response metadata (body not yet ready) ─
  const onResponseReceived = (params: {
    requestId: string;
    response: { url: string; status: number; mimeType: string; headers: Record<string, string> };
    timestamp: number;
  }) => {
    const req = pending.get(params.requestId);
    if (!req) return;

    req.status = params.response.status;
    req.contentType = params.response.mimeType || "";
    req.responseTimestamp = params.timestamp;
  };

  // ── loadingFinished: body available, emit trace ─────────────────────
  const onLoadingFinished = async (params: {
    requestId: string;
    timestamp: number;
  }) => {
    const req = pending.get(params.requestId);
    if (!req || req.status === undefined) return;
    pending.delete(params.requestId);

    // Always skip non-HTTP protocols
    if (shouldSkipProtocol(req.url)) return;

    const contentType = req.contentType!;
    const status = req.status;

    // Apply filter: custom predicate > default path + include checks
    if (filter) {
      if (!filter({ url: req.url, contentType, status })) return;
    } else {
      if (shouldSkipPath(req.url, excludePaths)) return;
      if (!shouldInclude(contentType, include)) return;
    }

    const duration = Math.round(
      (req.responseTimestamp ?? params.timestamp) * 1000 - req.startMs,
    );

    // Always capture response body for traced requests. Body filtering
    // and redaction happen downstream in the runner/CLI pipeline.
    let responseBody: unknown;
    try {
      const result = await cdp.send("Network.getResponseBody", {
        requestId: params.requestId,
      }) as { body: string; base64Encoded: boolean };

      if (!result.base64Encoded) {
        const raw = result.body.length > MAX_BODY_BYTES
          ? result.body.slice(0, MAX_BODY_BYTES) + "…[truncated]"
          : result.body;
        try {
          responseBody = JSON.parse(raw);
        } catch {
          responseBody = raw;
        }
      }
    } catch {
      // Body not available (cached, redirected, etc.) — skip silently.
    }

    // Parse request body as JSON if possible.
    let requestBody: unknown;
    if (req.requestBody) {
      try {
        requestBody = JSON.parse(req.requestBody);
      } catch {
        requestBody = req.requestBody;
      }
    }

    trace({
      protocol: "http",
      target: `${req.method} ${shortPath(req.url)}`,
      durationMs: duration,
      ok: status < 400,
      name: `[browser] ${req.method} ${shortPath(req.url)}`,
      method: req.method,
      url: req.url,
      status,
      duration,
      ...(requestBody !== undefined && { requestBody }),
      ...(responseBody !== undefined && { responseBody }),
    });
  };

  const onLoadingFailed = (params: { requestId: string }) => {
    pending.delete(params.requestId);
  };

  cdp.on("Network.requestWillBeSent", onRequestWillBeSent);
  cdp.on("Network.responseReceived", onResponseReceived);
  cdp.on("Network.loadingFinished", onLoadingFinished);
  cdp.on("Network.loadingFailed", onLoadingFailed);

  return async () => {
    cdp.off("Network.requestWillBeSent", onRequestWillBeSent);
    cdp.off("Network.responseReceived", onResponseReceived);
    cdp.off("Network.loadingFinished", onLoadingFinished);
    cdp.off("Network.loadingFailed", onLoadingFailed);
    try {
      await cdp.detach();
    } catch {
      // page may already be closed
    }
  };
}

function shortPath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}
