/**
 * Load egress HTTP transport — the out-of-process HTTP client the load orchestrator
 * injects into the engine core so a pressure run can use HTTP/2 with a controlled
 * connection-reuse ratio (D1 HTTP transport slice).
 *
 * The engine's egress path is `ky → services.fetch`. By default that fetch is
 * `globalThis.fetch` (Node's built-in undici), which is hard-wired to HTTP/1.1 with
 * one connection per in-flight request and cannot be tuned. For load we instead build
 * a dedicated npm-`undici` {@link Agent} (a stateful connection pool) and wrap
 * undici's own `fetch` to dispatch through it — WITHOUT touching `globalThis.fetch`
 * or `setGlobalDispatcher` (no global side effect, no double-undici-instance hazard;
 * empirically clean against Node's built-in undici).
 *
 * Two knobs (owner spec):
 *  - `preferH2` (default true): pass `connect: { preferH2: true }` so the Agent
 *    negotiates HTTP/2 via TLS ALPN. **Only affects `https` targets** — a plain
 *    `http://` target has no ALPN handshake, so undici stays HTTP/1.1 (no h2c
 *    cleartext). This is why the existing `http://127.0.0.1` load tests are
 *    unaffected by the h2-by-default change: they auto-negotiate down to h1.
 *  - `streamsPerConnection` (default 5): the connection-reuse ratio. The Agent's
 *    `connections` (max connections per origin) is `ceil(concurrency / streamsPerConnection)`,
 *    so with h2 those N connections each multiplex ~`streamsPerConnection` concurrent
 *    streams. **HTTP/2 only** — under h1 a connection carries one in-flight request,
 *    so the ratio is meaningless and ignored (a warning fires if it was set > 1).
 *
 * The Agent is a resource (open sockets): the orchestrator creates ONE per run and
 * `close()`s it at run end so connections never leak / hold the process open.
 */
import { Agent, fetch as undiciFetch } from "undici";
import type { FetchImpl } from "@glubean/engine";
import type { LoadHttpConfig } from "@glubean/sdk/load";

/** Default HTTP/2 preference (load exercises realistic h2 traffic by default). */
export const LOAD_HTTP_DEFAULT_PREFER_H2 = true;
/** Default h2 stream-multiplexing ratio (concurrent streams per connection). */
export const LOAD_HTTP_DEFAULT_STREAMS_PER_CONNECTION = 5;

/** Fully-resolved transport config (every field defaulted). */
export interface ResolvedLoadHttpConfig {
  preferH2: boolean;
  streamsPerConnection: number;
}

/**
 * The EXPLICIT `streamsPerConnection` a run configured (plan-level over the yaml default),
 * or `undefined` when neither set it. Keyed on the explicit value — not the defaulted 5 —
 * so the warnings below never fire for the built-in default. Shared by config resolution
 * and both h1-ignore warnings so they can't drift.
 */
export function loadHttpExplicitStreamsPerConnection(
  planHttp: LoadHttpConfig | undefined,
  yamlDefault: LoadHttpConfig | undefined,
): number | undefined {
  return planHttp?.streamsPerConnection ?? yamlDefault?.streamsPerConnection;
}

/**
 * Resolve the effective transport config from the plan-level `http` (authored in the
 * `.load.ts`) layered over an optional glubean.yaml `load.http` default, over the
 * built-in defaults — plan wins per field, yaml next, built-in last. Validates
 * `streamsPerConnection` (positive integer) the same way the orchestrator validates
 * its other numeric bounds, throwing a `loadRunner "<id>"`-prefixed error so a bad
 * value fails fast and consistently. Pure (no side effects / no logging).
 */
export function resolveLoadHttpConfig(
  planId: string,
  planHttp: LoadHttpConfig | undefined,
  yamlDefault: LoadHttpConfig | undefined,
): ResolvedLoadHttpConfig {
  const preferH2 =
    planHttp?.preferH2 ?? yamlDefault?.preferH2 ?? LOAD_HTTP_DEFAULT_PREFER_H2;
  const streamsExplicit = loadHttpExplicitStreamsPerConnection(planHttp, yamlDefault);
  if (
    streamsExplicit !== undefined &&
    (!Number.isInteger(streamsExplicit) || streamsExplicit < 1)
  ) {
    throw new Error(
      `loadRunner "${planId}": http.streamsPerConnection must be a positive integer (got ${streamsExplicit})`,
    );
  }
  return {
    preferH2,
    streamsPerConnection: streamsExplicit ?? LOAD_HTTP_DEFAULT_STREAMS_PER_CONNECTION,
  };
}

/**
 * The one-time warning to print when `streamsPerConnection` was EXPLICITLY set > 1 but
 * `preferH2` is false — under HTTP/1.1 there is no stream multiplexing, so the ratio has
 * no effect on ANY target. Config-time knowable (no target scheme needed), so callers
 * emit it once per run (top-level `runLoad` / coordinator). Returns `undefined` when
 * there is nothing to warn about. (The plain-http-under-preferH2:true case is a SEPARATE,
 * runtime warning — see {@link loadHttpPlainHttpIgnoreWarning} — because it depends on the
 * actual target scheme, and the DEFAULT ratio under an http target auto-falls-back
 * silently with no warning at all.)
 */
export function loadHttpH1IgnoreWarning(
  planHttp: LoadHttpConfig | undefined,
  yamlDefault: LoadHttpConfig | undefined,
): string | undefined {
  const preferH2 =
    planHttp?.preferH2 ?? yamlDefault?.preferH2 ?? LOAD_HTTP_DEFAULT_PREFER_H2;
  const streamsExplicit = loadHttpExplicitStreamsPerConnection(planHttp, yamlDefault);
  if (preferH2 === false && streamsExplicit !== undefined && streamsExplicit > 1) {
    return (
      `streamsPerConnection is HTTP/2-only and ignored under preferH2:false ` +
      `(HTTP/1.1 has no stream multiplexing — one in-flight request per connection).`
    );
  }
  return undefined;
}

/**
 * The warning to emit ONCE, at runtime, the first time a run under `preferH2:true` sends
 * to a plain-`http://` target while `streamsPerConnection` was EXPLICITLY set > 1 — a
 * cleartext target can't multiplex, so the transport sizes its pool to `slotCount` (one
 * connection per concurrent request) and the ratio is ignored FOR THAT TARGET. Runtime
 * (not config-time) because it depends on the actual request scheme, which may be a
 * `{{VAR}}` template resolved at dispatch or a run mixing http/https origins. Returns
 * `undefined` when the ratio is defaulted (silent auto-fallback — no warning) or
 * `preferH2` is false (that case is {@link loadHttpH1IgnoreWarning} instead).
 */
export function loadHttpPlainHttpIgnoreWarning(
  planHttp: LoadHttpConfig | undefined,
  yamlDefault: LoadHttpConfig | undefined,
): string | undefined {
  const preferH2 =
    planHttp?.preferH2 ?? yamlDefault?.preferH2 ?? LOAD_HTTP_DEFAULT_PREFER_H2;
  const streamsExplicit = loadHttpExplicitStreamsPerConnection(planHttp, yamlDefault);
  if (preferH2 !== false && streamsExplicit !== undefined && streamsExplicit > 1) {
    return `streamsPerConnection ignored for plain-http target (no multiplexing).`;
  }
  return undefined;
}

/**
 * Connection-pool size for a given concurrency (slot count) and reuse ratio:
 * `ceil(slotCount / streamsPerConnection)`, floored at 1. In multi-core each worker
 * passes its OWN `shard.slotCount` (each worker process owns an independent pool), so
 * the workers' connection counts sum to ≈ the global concurrency's pool.
 *
 * undici's `connections` is the pool CAP and, with concurrent in-flight requests, undici
 * opens up to that many connections and spreads streams across them — so this IS the
 * multiplexing lever: a low cap makes h2 multiplex ~`streamsPerConnection` concurrent
 * streams per connection. It applies PER ORIGIN but uniformly (one cap for every origin
 * under an Agent), so a plain-http origin under an h2-sized cap would be throttled — which
 * is exactly why {@link createLoadTransport} routes http origins to a SEPARATE `slotCount`
 * pool rather than reusing the h2 cap.
 */
export function computeLoadConnections(slotCount: number, streamsPerConnection: number): number {
  return Math.max(1, Math.ceil(slotCount / streamsPerConnection));
}

/** A live transport: the fetch to inject, plus the pool `close()` the run must call. */
export interface LoadTransport {
  fetch: FetchImpl;
  /** Close every Agent this transport opened (drain + close their connections). */
  close(): Promise<void>;
}

/** True for an `https://` URL (case-insensitive scheme). `Request.url` / `URL.href` have
 *  a lowercase scheme; a raw string may not, so match case-insensitively and cheaply
 *  (no `new URL()` per request on the hot path). */
function isHttpsUrl(url: string | URL): boolean {
  return typeof url === "string" ? /^https:/i.test(url) : url.protocol === "https:";
}

/**
 * Build the load transport: up to TWO undici {@link Agent}s (connection pools) routed by
 * the per-request target SCHEME, plus a `fetch` that dispatches through the right one.
 * TLS options keep undici's secure defaults (`rejectUnauthorized` stays on) — only the
 * ALPN preference is added to `connect`.
 *
 * WHY TWO POOLS (owner decision 2026-07-17): undici's `connections` is one cap applied
 * uniformly to every origin under an Agent (verified: a plain-http origin under a
 * `ceil(slotCount/spc)` cap is throttled to that few h1 connections). So the pool is sized
 * by the target's ACTUAL protocol, not by `preferH2` alone:
 *  - `https://` under `preferH2:true` → the h2 pool: `ceil(slotCount / streamsPerConnection)`
 *    connections, `allowH2:true, preferH2:true` — the reuse ratio multiplexes ~spc streams
 *    per connection where h2 can actually be negotiated (TLS ALPN).
 *  - everything else — every `http://` target (cleartext → always h1, no multiplexing) AND
 *    every target when `preferH2:false` — → the h1 pool: `slotCount` connections (one per
 *    concurrent request), `allowH2:false`. `streamsPerConnection` is ignored here (nothing
 *    to multiplex), so a plain-http load is NEVER silently throttled.
 * A run mixing http + https origins gets each request routed to the correct pool.
 *
 * ALPN nuance: undici's `allowH2` defaults true and `preferH2` only REORDERS the ALPN list —
 * the SERVER picks — so `preferH2:false` alone would still let an h2-preferring server
 * choose h2. The h1 pool sets `allowH2:false` (h2 not offered) for a firm HTTP/1.1 contract.
 *
 * Both pools are created LAZILY on first use of their scheme, so a run that only hits one
 * scheme opens one pool; `close()` closes whichever were opened. The optional
 * `connectOverrides` merges EXTRA connect options (production never sets it — secure
 * defaults preserved); it exists only so a self-signed-cert h2 test can pass
 * `{ rejectUnauthorized: false }`. `httpIgnoreWarning`, when set, is printed ONCE the first
 * time an `http://` request is routed to the h1 pool (the runtime plain-http-ignore notice —
 * see {@link loadHttpPlainHttpIgnoreWarning}).
 */
export function createLoadTransport(opts: {
  preferH2: boolean;
  /** This shard's concurrency — the h1 pool size (one connection per concurrent request). */
  slotCount: number;
  /** h2 reuse ratio — the https pool is `ceil(slotCount / streamsPerConnection)`. */
  streamsPerConnection: number;
  connectOverrides?: Record<string, unknown>;
  /** Printed once (console.warn) the first time a plain-`http://` request is routed to the
   *  h1 pool under `preferH2:true` with an explicit `streamsPerConnection > 1`. */
  httpIgnoreWarning?: string;
}): LoadTransport {
  const overrides = opts.connectOverrides ?? {};
  const h1Connections = Math.max(1, opts.slotCount);
  const h2Connections = computeLoadConnections(opts.slotCount, opts.streamsPerConnection);

  // Lazily-built pools: h1 (one-per-request, no h2 offered) and h2 (multiplexing). Only the
  // scheme(s) a run actually hits get a pool.
  let h1Agent: Agent | undefined;
  let h2Agent: Agent | undefined;
  const getH1 = (): Agent =>
    (h1Agent ??= new Agent({ connections: h1Connections, connect: { ...overrides, allowH2: false } }));
  const getH2 = (): Agent =>
    (h2Agent ??= new Agent({ connections: h2Connections, connect: { ...overrides, allowH2: true, preferH2: true } }));

  let httpWarned = false;
  const pickAgent = (https: boolean): Agent => {
    if (opts.preferH2 && https) return getH2();
    // Plain http under preferH2:true with an explicit ratio → the ratio is ignored for this
    // (unmultiplexable) target; surface it once, then fall through to the h1 pool.
    if (opts.preferH2 && !https && opts.httpIgnoreWarning !== undefined && !httpWarned) {
      httpWarned = true;
      console.warn(opts.httpIgnoreWarning);
    }
    return getH1();
  };

  // ky calls services.fetch(request, options); route it through the pooled Agent via
  // undici's per-request `dispatcher` option (NOT setGlobalDispatcher — no global state).
  //
  // Double-undici hazard: npm `undici` and Node's built-in undici are DIFFERENT instances,
  // so (a) built-in `globalThis.fetch` rejects an npm-undici Agent dispatcher (handler-
  // interface skew), and (b) npm-undici `fetch` does NOT brand-recognize the GLOBAL
  // `Request` object ky constructs (it stringifies it → "Failed to parse URL"). We avoid
  // both by calling npm-undici `fetch` and NORMALIZING the incoming (global) Request into
  // `(url, init)` that undici builds its OWN Request from — carrying method / headers /
  // signal / body (a global `ReadableStream` body needs `duplex: 'half'`). A string/URL
  // input passes straight through.
  const fetchImpl: FetchImpl = (input, init) => {
    let url: string | URL;
    let requestInit: Record<string, unknown>;
    if (typeof Request !== "undefined" && input instanceof Request) {
      const r = input;
      url = r.url;
      requestInit = { method: r.method, headers: r.headers, signal: r.signal, ...(init as Record<string, unknown>) };
      if (r.method !== "GET" && r.method !== "HEAD" && r.body !== null) {
        requestInit.body = r.body;
        requestInit.duplex = "half";
      }
    } else {
      url = input as string | URL;
      requestInit = { ...(init as Record<string, unknown>) };
    }
    requestInit.dispatcher = pickAgent(isHttpsUrl(url));
    return undiciFetch(
      url as Parameters<typeof undiciFetch>[0],
      requestInit as Parameters<typeof undiciFetch>[1],
    ) as unknown as Promise<Response>;
  };
  const close = async (): Promise<void> => {
    await Promise.all([
      ...(h1Agent !== undefined ? [h1Agent.close()] : []),
      ...(h2Agent !== undefined ? [h2Agent.close()] : []),
    ]);
  };
  return { fetch: fetchImpl, close };
}
