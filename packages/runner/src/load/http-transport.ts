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

/** True for an `https://` URL (case-insensitive scheme). `Request.url` / `URL.href` have
 *  a lowercase scheme; a raw string may not, so match case-insensitively and cheaply
 *  (no `new URL()` per request on the hot path). */
function isHttpsUrl(url: string | URL): boolean {
  return typeof url === "string" ? /^https:/i.test(url) : url.protocol === "https:";
}

/** The `scheme://host:port` origin of a URL — the h2 round-robin cursor's key (a per-origin
 *  cursor keeps each origin's connection count = K regardless of cross-origin arrival order).
 *  Parsed only on the h2 path (https + preferH2), never for h1. A malformed URL groups under
 *  its raw string (undici rejects it downstream anyway). */
function originOf(url: string | URL): string {
  try {
    return typeof url === "string" ? new URL(url).origin : url.origin;
  } catch {
    return String(url);
  }
}

/**
 * Build the load transport: a `fetch` that routes each request to a pooled undici Agent by
 * the request's target SCHEME, plus graceful `close()` / destructive `destroy()` teardown.
 * TLS options keep undici's secure defaults (`rejectUnauthorized` stays on) — only the ALPN
 * preference is added to `connect`.
 *
 * ENFORCING THE REUSE RATIO — h1/h2 ASYMMETRY (owner decision 2026-07-17): undici's
 * `connections` is only an UPPER BOUND, and under h2 undici multiplexes as few connections
 * as possible (verified: under a real staggered ramp a `connections:20` Agent collapses to
 * ONE h2 connection carrying every stream — the server's SETTINGS `maxConcurrentStreams`
 * overrides any client-side cap, so `connections` never forces spreading). The ONLY reliable
 * way to force exactly K h2 connections is K SEPARATE `connections:1` Agents round-robined
 * per request — each is exactly one h2 connection multiplexing ~`streamsPerConnection`
 * streams. So the two schemes are sized DIFFERENTLY:
 *  - **h2 pool** (`https://` under `preferH2:true`): K = `ceil(slotCount / streamsPerConnection)`
 *    single-connection Agents, round-robined → exactly K connections, ratio enforced.
 *  - **h1 pool** (`http://` cleartext — always h1 — OR any target under `preferH2:false`): ONE
 *    Agent with `connections: slotCount`, `allowH2:false`. h1 has no multiplexing, so the
 *    `connections` cap IS the real connection count (undici must open one per concurrent
 *    request) — no round-robin needed, and `streamsPerConnection` is ignored (nothing to
 *    multiplex), so a plain-http load is never throttled.
 * A run mixing http + https origins routes each DIRECT request (each `fetch` call ky makes)
 * to the right pool by its own scheme + origin. NOTE (accepted boundary, D1-7 review): undici
 * follows redirects INTERNALLY within the ONE dispatcher chosen for the initial URL — there is
 * no per-hop dispatcher hook in undici's fetch — so a FOLLOWED redirect that crosses origin
 * (A→C) reuses A's Agent for the C hop. The request still succeeds (C is reached), but C's
 * traffic does NOT enter C's own per-origin round-robin, so the exact per-origin connection
 * density (K) is only GUARANTEED for direct requests; a followed cross-origin redirect's target
 * gets between 1 and K connections. This is a bounded, edge-case deviation (a load run that both
 * follows redirects AND crosses origins mid-chain) — not worth the large, redirect-semantics-
 * altering change of manual redirect following (which would also fight `redirect:'manual'`
 * preservation below). Direct-request density — the common case — is exact.
 *
 * ALPN nuance: undici's `allowH2` defaults true and `preferH2` only REORDERS the ALPN list —
 * the SERVER picks — so `preferH2:false` alone would still let an h2-preferring server choose
 * h2. The h1 pool sets `allowH2:false` (h2 not offered) for a firm HTTP/1.1 contract.
 *
 * All Agents are created LAZILY on first use of their scheme; `close()`/`destroy()` tear down
 * whichever were opened. `connectOverrides` merges EXTRA connect options (production never
 * sets it — secure defaults preserved); it exists only so a self-signed-cert h2 test can pass
 * `{ rejectUnauthorized: false }`. `httpIgnoreWarning`, when set, is printed ONCE the first
 * time an `http://` request is routed to the h1 pool under `preferH2:true` (the runtime
 * plain-http-ignore notice — see {@link loadHttpPlainHttpIgnoreWarning}).
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
  const overrides = opts.connectOverrides ?? {};
  const h1Connections = Math.max(1, opts.slotCount);
  const h2Count = computeLoadConnections(opts.slotCount, opts.streamsPerConnection);

  // h1: ONE Agent, connections = slotCount (the cap IS the real count for h1 — no multiplexing).
  let h1Agent: Agent | undefined;
  const getH1 = (): Agent =>
    (h1Agent ??= new Agent({ connections: h1Connections, connect: { ...overrides, allowH2: false } }));

  // h2: K single-connection Agents, round-robined per request → exactly K h2 connections per
  // origin, each multiplexing ~streamsPerConnection streams (a single Agent's `connections` cap
  // can't force this — see the header). Built as one batch on first https use. The K Agents are
  // SHARED across origins (each is `connections:1` PER ORIGIN, so K Agents already give every
  // origin its own K connections — replicating Agents per origin would be a connection explosion).
  // The CURSOR, however, is PER ORIGIN: a single shared cursor would let cross-origin arrival
  // order decide which subset of the K Agents an origin lands on (fewer than K connections, or an
  // uneven split), making the per-origin connection count traffic-order-dependent. A per-origin
  // cursor pins each origin to its own K-way round-robin → exactly K connections/origin, stable
  // regardless of how requests to different origins interleave.
  let h2Agents: Agent[] | undefined;
  const h2CursorByOrigin = new Map<string, number>();
  const getH2 = (origin: string): Agent => {
    if (h2Agents === undefined) {
      h2Agents = Array.from(
        { length: h2Count },
        () => new Agent({ connections: 1, connect: { ...overrides, allowH2: true, preferH2: true } }),
      );
    }
    // Single-process async — a plain get/increment/set is atomic enough (no preemption mid-op).
    const cursor = h2CursorByOrigin.get(origin) ?? 0;
    h2CursorByOrigin.set(origin, cursor + 1);
    return h2Agents[cursor % h2Agents.length];
  };

  let httpWarned = false;
  const pickAgent = (url: string | URL): Agent => {
    const https = isHttpsUrl(url);
    if (opts.preferH2 && https) return getH2(originOf(url));
    // Plain http under preferH2:true with an explicit ratio → the ratio is ignored for this
    // (unmultiplexable) target; surface it once, then fall through to the h1 pool.
    if (opts.preferH2 && !https && opts.httpIgnoreWarning !== undefined && !httpWarned) {
      httpWarned = true;
      console.warn(opts.httpIgnoreWarning);
    }
    return getH1();
  };

  // ky calls services.fetch(request, options); route it through the pooled Agent via undici's
  // per-request `dispatcher` option (NOT setGlobalDispatcher — no global state).
  //
  // Double-undici hazard: npm `undici` and Node's built-in undici are DIFFERENT instances, so
  // (a) built-in `globalThis.fetch` rejects an npm-undici Agent dispatcher (handler-interface
  // skew), and (b) npm-undici `fetch` does NOT brand-recognize the GLOBAL `Request` object ky
  // constructs (it stringifies it → "Failed to parse URL"). We avoid both by calling npm-undici
  // `fetch` and NORMALIZING the incoming (global) Request into `(url, init)` that undici builds
  // its OWN Request from — carrying the request's semantics: method / headers / signal / body
  // (a global `ReadableStream` body needs `duplex:'half'`), AND redirect / credentials / mode /
  // integrity (else a scenario's `redirect:'manual'`/`'error'` would silently become the default
  // `'follow'`, generating extra traffic + returning the final response instead of the 3xx).
  // The dispatcher is chosen per fetch CALL by that call's target scheme+origin; undici follows
  // any redirects INTERNALLY on that one dispatcher (see the createLoadTransport header — a
  // followed cross-origin redirect stays on the initial origin's Agent; direct-request density
  // is exact). A string/URL input passes through.
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
    requestInit.dispatcher = pickAgent(url);
    return undiciFetch(
      url as Parameters<typeof undiciFetch>[0],
      requestInit as Parameters<typeof undiciFetch>[1],
    ) as unknown as Promise<Response>;
  };

  const allAgents = (): Agent[] => [...(h1Agent !== undefined ? [h1Agent] : []), ...(h2Agents ?? [])];
  const close = async (): Promise<void> => {
    await Promise.all(allAgents().map((a) => a.close()));
  };
  const destroy = async (): Promise<void> => {
    // `destroy()` aborts in-flight requests immediately (bounded); tolerate any per-Agent throw.
    await Promise.all(allAgents().map((a) => a.destroy().catch(() => {})));
  };
  return { fetch: fetchImpl, close, destroy };
}
