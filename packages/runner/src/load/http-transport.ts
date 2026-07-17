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
// npm `undici` (NOT Node's built-in undici — see the double-undici note in createLoadTransport).
// We pin undici 8 for `connect.preferH2` (h2-first ALPN), which reliably negotiates HTTP/2 over
// TLS; undici 7.x has NO `preferH2` option (only `allowH2`, h1-first ALPN — server-preference
// decides) — it was added in undici 8. undici 8 requires Node >=22.19.0, which every publishable
// package's `engines.node` now reflects (bumped from >=22).
import { Agent, Dispatcher, fetch as undiciFetch } from "undici";
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
 * The number of h2 connections that carry `slotCount` concurrent requests at the reuse
 * ratio: `ceil(slotCount / streamsPerConnection)`, floored at 1. This is the COUNT of
 * single-connection Agents the transport round-robins over (see {@link createLoadTransport}),
 * so each connection multiplexes ~`streamsPerConnection` concurrent streams. In multi-core
 * each worker passes its OWN `shard.slotCount`, so the workers' connection counts sum to ≈
 * the global concurrency's.
 */
export function computeLoadConnections(slotCount: number, streamsPerConnection: number): number {
  return Math.max(1, Math.ceil(slotCount / streamsPerConnection));
}

/** A live transport: the fetch to inject, plus bounded/graceful teardown. */
export interface LoadTransport {
  fetch: FetchImpl;
  /** GRACEFUL close — waits for every open Agent's in-flight requests to finish. */
  close(): Promise<void>;
  /** DESTRUCTIVE close — aborts in-flight requests at once (bounded). Used when a coarse
   *  abort / drain-timeout left a request in flight that `close()` would wait on forever. */
  destroy(): Promise<void>;
}

/** True for an `https://` origin string (case-insensitive; undici passes `opts.origin` as a
 *  normalized `scheme://host:port`, so a cheap prefix test suffices — no URL parse on the hot path). */
function isHttpsOrigin(origin: string): boolean {
  return /^https:/i.test(origin);
}

/** Config the {@link LoadRouterDispatcher} needs to pick a pool. */
interface RouterConfig {
  preferH2: boolean;
  /** h1 pool size (one connection per concurrent request — h1 has no multiplexing). */
  h1Connections: number;
  /** h2 round-robin width = `ceil(slotCount / streamsPerConnection)` single-connection Agents. */
  h2Count: number;
  connectOverrides: Record<string, unknown>;
  httpIgnoreWarning?: string;
}

/**
 * A router {@link Dispatcher}: undici's fetch calls `dispatch(opts, handler)` for EVERY hop —
 * including each redirect hop — with `opts.origin` = that hop's ACTUAL origin (verified on undici
 * 8.7). Passing THIS router as the fetch `dispatcher` (instead of one concrete Agent picked up
 * front) makes pool selection happen per hop, so the per-origin connection-density + protocol
 * guarantees hold for direct requests AND followed redirects — even a cross-origin / cross-scheme
 * redirect (http→https, https→http) lands each hop on the right pool. undici still follows
 * redirects internally; the router only chooses the dispatcher per hop, never touching redirect
 * semantics (so a scenario's `redirect:'manual'`/`'error'` is preserved by the Request
 * normalization in {@link createLoadTransport}).
 *
 * ENFORCING THE REUSE RATIO — h1/h2 ASYMMETRY (owner decision 2026-07-17): undici's `connections`
 * is only an UPPER BOUND, and under h2 undici multiplexes as few connections as possible (verified:
 * under a staggered ramp a `connections:20` Agent collapses to ONE h2 connection carrying every
 * stream — the server's SETTINGS `maxConcurrentStreams` overrides any client-side cap, so
 * `connections` never forces spreading). The ONLY reliable way to force exactly K h2 connections
 * is K SEPARATE `connections:1` Agents round-robined per request — each is exactly one h2
 * connection multiplexing ~`streamsPerConnection` streams. So the two schemes are sized DIFFERENTLY:
 *  - **h2 pool** (`https://` under `preferH2:true`): K = `ceil(slotCount / streamsPerConnection)`
 *    single-connection Agents. They are SHARED across origins (each is `connections:1` PER ORIGIN,
 *    so K Agents already give every origin its own K connections — replicating Agents per origin
 *    would be a connection explosion). The round-robin CURSOR is PER ORIGIN: a shared cursor would
 *    let cross-origin arrival order pin an origin to a subset of the K Agents (uneven density); a
 *    per-origin cursor gives each origin its own 0..K-1 rotation → exactly K connections/origin,
 *    stable regardless of interleave.
 *  - **h1 pool** (`http://` cleartext — always h1 — OR any target under `preferH2:false`): ONE
 *    Agent with `connections: slotCount`, `allowH2:false`. h1 has no multiplexing, so the
 *    `connections` cap IS the real connection count (undici must open one per concurrent request)
 *    — no round-robin needed, and `streamsPerConnection` is ignored (nothing to multiplex), so a
 *    plain-http load is never throttled.
 *
 * ALPN nuance: undici's `allowH2` defaults true and `preferH2` only REORDERS the ALPN list — the
 * SERVER picks — so `preferH2:false` alone would still let an h2-preferring server choose h2. The
 * h1 pool sets `allowH2:false` (h2 not offered) for a firm HTTP/1.1 contract.
 *
 * All Agents are created LAZILY on first use of their scheme; `close()`/`destroy()` tear down
 * whichever were opened (overload-compatible with undici's `Dispatcher` so an internal
 * callback-form call is safe too). `connectOverrides` merges EXTRA connect options (production
 * never sets it — secure defaults preserved); it exists only so a self-signed-cert h2 test can
 * pass `{ rejectUnauthorized: false }`.
 */
class LoadRouterDispatcher extends Dispatcher {
  private readonly cfg: RouterConfig;
  private h1Agent?: Agent;
  private h2Agents?: Agent[];
  private readonly h2CursorByOrigin = new Map<string, number>();
  private httpWarned = false;

  constructor(cfg: RouterConfig) {
    super();
    this.cfg = cfg;
  }

  private getH1(): Agent {
    return (this.h1Agent ??= new Agent({
      connections: this.cfg.h1Connections,
      connect: { ...this.cfg.connectOverrides, allowH2: false },
    }));
  }

  private getH2(origin: string): Agent {
    if (this.h2Agents === undefined) {
      this.h2Agents = Array.from(
        { length: this.cfg.h2Count },
        () => new Agent({ connections: 1, connect: { ...this.cfg.connectOverrides, allowH2: true, preferH2: true } }),
      );
    }
    // Single-process async — a plain get/increment/set is atomic enough (no preemption mid-op).
    const cursor = this.h2CursorByOrigin.get(origin) ?? 0;
    this.h2CursorByOrigin.set(origin, cursor + 1);
    return this.h2Agents[cursor % this.h2Agents.length];
  }

  private pick(origin: string): Agent {
    if (this.cfg.preferH2 && isHttpsOrigin(origin)) return this.getH2(origin);
    // Plain http under preferH2:true with an explicit ratio → the ratio is ignored for this
    // (unmultiplexable) target; surface it once, then fall through to the h1 pool.
    if (this.cfg.preferH2 && !isHttpsOrigin(origin) && this.cfg.httpIgnoreWarning !== undefined && !this.httpWarned) {
      this.httpWarned = true;
      console.warn(this.cfg.httpIgnoreWarning);
    }
    return this.getH1();
  }

  private openAgents(): Agent[] {
    return [...(this.h1Agent !== undefined ? [this.h1Agent] : []), ...(this.h2Agents ?? [])];
  }

  override dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    // `opts.origin` is this hop's real origin (per-hop routing: redirects re-enter here).
    const origin = typeof opts.origin === "string" ? opts.origin : opts.origin?.origin ?? "";
    return this.pick(origin).dispatch(opts, handler);
  }

  // close/destroy delegate to the open child Agents. Overload-compatible with undici's Dispatcher
  // (promise form AND callback form) so an internal callback-style call can't break — though only
  // the transport's own `close()`/`destroy()` (promise form) invoke these.
  override close(): Promise<void>;
  override close(callback: () => void): void;
  override close(callback?: () => void): Promise<void> | void {
    const p = Promise.all(this.openAgents().map((a) => a.close())).then(() => undefined);
    if (callback) {
      void p.then(() => callback(), () => callback());
      return;
    }
    return p;
  }

  override destroy(): Promise<void>;
  override destroy(err: Error | null): Promise<void>;
  override destroy(callback: () => void): void;
  override destroy(err: Error | null, callback: () => void): void;
  override destroy(errOrCb?: Error | null | (() => void), callback?: () => void): Promise<void> | void {
    const cb = typeof errOrCb === "function" ? errOrCb : callback;
    // `destroy()` aborts in-flight requests immediately (bounded); tolerate any per-Agent throw.
    const p = Promise.all(this.openAgents().map((a) => a.destroy().catch(() => {}))).then(() => undefined);
    if (cb) {
      void p.then(() => cb(), () => cb());
      return;
    }
    return p;
  }
}

/**
 * Build the load transport: a `fetch` that dispatches through a {@link LoadRouterDispatcher}
 * (per-hop, per-origin pool routing — see that class), plus graceful `close()` / destructive
 * `destroy()` teardown. TLS options keep undici's secure defaults (`rejectUnauthorized` stays on)
 * — only the ALPN preference is added to `connect`.
 *
 * `httpIgnoreWarning`, when set, is printed ONCE the first time an `http://` request is routed to
 * the h1 pool under `preferH2:true` (the runtime plain-http-ignore notice — see
 * {@link loadHttpPlainHttpIgnoreWarning}).
 */
export function createLoadTransport(opts: {
  preferH2: boolean;
  /** This shard's concurrency — sizes both pools (h1 `connections`, and the h2 Agent count). */
  slotCount: number;
  /** h2 reuse ratio — the https pool uses `ceil(slotCount / streamsPerConnection)` connections. */
  streamsPerConnection: number;
  connectOverrides?: Record<string, unknown>;
  /** Printed once the first time a plain-`http://` request is routed to the h1 pool under
   *  `preferH2:true` with an explicit `streamsPerConnection > 1`. */
  httpIgnoreWarning?: string;
}): LoadTransport {
  const router = new LoadRouterDispatcher({
    preferH2: opts.preferH2,
    h1Connections: Math.max(1, opts.slotCount),
    h2Count: computeLoadConnections(opts.slotCount, opts.streamsPerConnection),
    connectOverrides: opts.connectOverrides ?? {},
    ...(opts.httpIgnoreWarning !== undefined ? { httpIgnoreWarning: opts.httpIgnoreWarning } : {}),
  });

  // ky calls services.fetch(request, options); dispatch through the router (NOT setGlobalDispatcher
  // — no global state). The router selects the pool per hop by `opts.origin`.
  //
  // Double-undici hazard: npm `undici` and Node's built-in undici are DIFFERENT instances, so
  // (a) built-in `globalThis.fetch` rejects an npm-undici dispatcher (handler-interface skew), and
  // (b) npm-undici `fetch` does NOT brand-recognize the GLOBAL `Request` object ky constructs (it
  // stringifies it → "Failed to parse URL"). We avoid both by calling npm-undici `fetch` and
  // NORMALIZING the incoming (global) Request into `(url, init)` that undici builds its OWN Request
  // from — carrying the request's semantics: method / headers / signal / body (a global
  // `ReadableStream` body needs `duplex:'half'`), AND redirect / credentials / mode / integrity
  // (else a scenario's `redirect:'manual'`/`'error'` would silently become the default `'follow'`,
  // generating extra traffic + returning the final response instead of the 3xx). A string/URL
  // input passes straight through.
  const fetchImpl: FetchImpl = (input, init) => {
    let url: string | URL;
    let requestInit: Record<string, unknown>;
    if (typeof Request !== "undefined" && input instanceof Request) {
      const r = input;
      url = r.url;
      requestInit = {
        method: r.method,
        headers: r.headers,
        signal: r.signal,
        redirect: r.redirect,
        credentials: r.credentials,
        mode: r.mode,
        referrer: r.referrer,
        referrerPolicy: r.referrerPolicy,
        integrity: r.integrity,
        ...(init as Record<string, unknown>),
      };
      if (r.method !== "GET" && r.method !== "HEAD" && r.body !== null) {
        requestInit.body = r.body;
        requestInit.duplex = "half";
      }
    } else {
      url = input as string | URL;
      requestInit = { ...(init as Record<string, unknown>) };
    }
    requestInit.dispatcher = router;
    return undiciFetch(
      url as Parameters<typeof undiciFetch>[0],
      requestInit as Parameters<typeof undiciFetch>[1],
    ) as unknown as Promise<Response>;
  };

  return {
    fetch: fetchImpl,
    close: () => router.close(),
    destroy: () => router.destroy(),
  };
}
