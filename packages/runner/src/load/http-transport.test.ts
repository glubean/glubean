/**
 * http-transport — unit coverage for the load egress transport config resolution +
 * connection math + h1 warnings, plus real-server e2e for HTTP/2 multiplexing (the
 * connection-reuse ratio), the scheme-aware pool sizing (plain http NOT throttled), and
 * the plain-http auto-h1 guarantee.
 *
 * The h2 e2e needs a TLS server; it self-signs a localhost cert with `openssl` at module
 * load and SKIPS (not fails) if openssl is unavailable — the unit + plain-http coverage
 * still runs everywhere. The plain-http connection-count e2e is the load-bearing proof that
 * an `http://` target is sized to `slotCount` (one connection per concurrent request), NOT
 * the h2 reuse ratio — so a cleartext load is never silently throttled.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { createSecureServer, type Http2SecureServer } from "node:http2";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeLoadConnections,
  createLoadTransport,
  loadHttpExplicitStreamsPerConnection,
  loadHttpH1IgnoreWarning,
  loadHttpPlainHttpIgnoreWarning,
  resolveLoadHttpConfig,
} from "./http-transport.js";

/**
 * Self-sign a localhost cert with openssl at MODULE LOAD (synchronously) — `it.skipIf`
 * evaluates its condition at collection time, BEFORE `beforeAll`, so the cert must exist
 * by then or the h2 e2e is skipped everywhere. Absent openssl → `undefined` → the h2
 * e2e blocks skip while the unit + plain-http coverage still runs.
 */
const TLS = ((): { key: Buffer; cert: Buffer; dir: string } | undefined => {
  try {
    const dir = mkdtempSync(join(tmpdir(), "glubean-h2-"));
    execFileSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", join(dir, "key.pem"),
        "-out", join(dir, "cert.pem"),
        "-days", "2", "-subj", "/CN=localhost",
      ],
      { stdio: "ignore" },
    );
    return { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")), dir };
  } catch {
    return undefined;
  }
})();

describe("computeLoadConnections — ceil(slotCount / streamsPerConnection), floored at 1", () => {
  it("computes the reuse ratio at various points", () => {
    expect(computeLoadConnections(10, 5)).toBe(2); // 10 concurrency / 5 streams
    expect(computeLoadConnections(10, 1)).toBe(10); // spc=1 → one conn per slot
    expect(computeLoadConnections(3, 5)).toBe(1); // fewer slots than ratio → 1
    expect(computeLoadConnections(1, 5)).toBe(1);
    expect(computeLoadConnections(300, 5)).toBe(60);
    expect(computeLoadConnections(11, 5)).toBe(3); // ceil(11/5) = 3
    expect(computeLoadConnections(0, 5)).toBe(1); // floored at 1
  });
});

describe("loadHttpExplicitStreamsPerConnection — the configured (non-defaulted) ratio", () => {
  it("returns the plan value, then the yaml value, else undefined", () => {
    expect(loadHttpExplicitStreamsPerConnection({ streamsPerConnection: 3 }, { streamsPerConnection: 9 })).toBe(3);
    expect(loadHttpExplicitStreamsPerConnection({}, { streamsPerConnection: 9 })).toBe(9);
    expect(loadHttpExplicitStreamsPerConnection(undefined, undefined)).toBeUndefined();
    expect(loadHttpExplicitStreamsPerConnection({ preferH2: false }, undefined)).toBeUndefined();
  });
});

describe("resolveLoadHttpConfig — defaults, plan-over-yaml precedence, validation", () => {
  it("defaults to preferH2:true, streamsPerConnection:5 when nothing is set", () => {
    expect(resolveLoadHttpConfig("p", undefined, undefined)).toEqual({
      preferH2: true,
      streamsPerConnection: 5,
    });
  });

  it("plan wins per field over the yaml default", () => {
    const plan = { preferH2: false, streamsPerConnection: 3 };
    const yaml = { preferH2: true, streamsPerConnection: 10 };
    expect(resolveLoadHttpConfig("p", plan, yaml)).toEqual({
      preferH2: false,
      streamsPerConnection: 3,
    });
  });

  it("falls back to the yaml default per field when the plan omits it", () => {
    expect(resolveLoadHttpConfig("p", { preferH2: false }, { streamsPerConnection: 8 })).toEqual({
      preferH2: false,
      streamsPerConnection: 8,
    });
    expect(resolveLoadHttpConfig("p", {}, { preferH2: false })).toEqual({
      preferH2: false,
      streamsPerConnection: 5,
    });
  });

  it("rejects a non-positive / non-integer streamsPerConnection with a loadRunner-prefixed error", () => {
    expect(() => resolveLoadHttpConfig("checkout", { streamsPerConnection: 0 }, undefined)).toThrow(
      /loadRunner "checkout": http\.streamsPerConnection must be a positive integer \(got 0\)/,
    );
    expect(() => resolveLoadHttpConfig("checkout", { streamsPerConnection: 2.5 }, undefined)).toThrow(
      /positive integer \(got 2\.5\)/,
    );
    expect(() => resolveLoadHttpConfig("checkout", { streamsPerConnection: -1 }, undefined)).toThrow(
      /positive integer \(got -1\)/,
    );
    // A bad value in the yaml default is caught too (it feeds the same resolution).
    expect(() => resolveLoadHttpConfig("checkout", undefined, { streamsPerConnection: 0 })).toThrow(
      /positive integer/,
    );
  });
});

describe("loadHttpH1IgnoreWarning — preferH2:false + explicit spc>1 (config-time)", () => {
  it("warns when preferH2:false with an explicit streamsPerConnection > 1 (plan or yaml)", () => {
    expect(loadHttpH1IgnoreWarning({ preferH2: false, streamsPerConnection: 5 }, undefined)).toMatch(
      /streamsPerConnection is HTTP\/2-only and ignored under preferH2:false/,
    );
    expect(loadHttpH1IgnoreWarning({ preferH2: false }, { streamsPerConnection: 4 })).toMatch(/HTTP\/2-only/);
  });

  it("does NOT warn when spc is defaulted, is 1, or preferH2 stays true", () => {
    expect(loadHttpH1IgnoreWarning({ preferH2: false }, undefined)).toBeUndefined(); // spc defaulted → not explicit
    expect(loadHttpH1IgnoreWarning({ preferH2: false, streamsPerConnection: 1 }, undefined)).toBeUndefined();
    expect(loadHttpH1IgnoreWarning({ streamsPerConnection: 5 }, undefined)).toBeUndefined(); // preferH2 defaults true
    expect(loadHttpH1IgnoreWarning(undefined, undefined)).toBeUndefined();
  });
});

describe("loadHttpPlainHttpIgnoreWarning — preferH2:true + explicit spc>1 (runtime, plain-http)", () => {
  it("warns when preferH2 stays true with an explicit streamsPerConnection > 1", () => {
    expect(loadHttpPlainHttpIgnoreWarning({ streamsPerConnection: 5 }, undefined)).toMatch(
      /streamsPerConnection ignored for plain-http target \(no multiplexing\)/,
    );
    expect(loadHttpPlainHttpIgnoreWarning(undefined, { streamsPerConnection: 3 })).toMatch(/plain-http target/);
  });

  it("does NOT warn for the DEFAULT ratio (silent auto-fallback), spc=1, or preferH2:false", () => {
    expect(loadHttpPlainHttpIgnoreWarning(undefined, undefined)).toBeUndefined(); // default → silent
    expect(loadHttpPlainHttpIgnoreWarning({ streamsPerConnection: 1 }, undefined)).toBeUndefined();
    expect(loadHttpPlainHttpIgnoreWarning({ preferH2: false, streamsPerConnection: 5 }, undefined)).toBeUndefined(); // that's the h1 warning's job
  });
});

// ── e2e helpers ──────────────────────────────────────────────────────────────

type F = (input: Request) => Promise<Response>;

/**
 * A re-armable concurrency gate for a probe server: `arm(n)` opens a fresh gate that holds
 * every request until `n` have arrived, then releases them all at once (so undici must open
 * as many connections as its pool cap allows). The server handler reads the CURRENT gate per
 * request, so re-arming between tests is clean.
 */
function makeGate() {
  let expected = 1;
  let arrived = 0;
  let open: () => void = () => {};
  let gate: Promise<void> = Promise.resolve();
  return {
    arm(n: number): void {
      expected = n;
      arrived = 0;
      gate = new Promise<void>((r) => { open = r; });
    },
    onRequest(): Promise<void> {
      arrived += 1;
      if (arrived >= expected) open();
      return gate;
    },
  };
}

/** Fire `n` concurrent requests through the transport, collecting each `{ ver }` echo. */
async function concurrentProbe(fetchImpl: F, base: string, n: number): Promise<{ ver: string }[]> {
  const reqs = Array.from({ length: n }, (_, i) =>
    fetchImpl(new Request(`${base}/${i}`)).then((r) => r.json() as Promise<{ ver: string }>),
  );
  return Promise.all(reqs);
}

describe("createLoadTransport — HTTP/2 multiplexing over TLS (e2e)", () => {
  let server: Http2SecureServer | undefined;
  let base = "";
  let sessionCount = 0;
  const gate = makeGate();

  beforeAll(async () => {
    if (!TLS) return; // openssl unavailable → the it.skipIf blocks below skip
    server = createSecureServer({ key: TLS.key, cert: TLS.cert, allowHTTP1: true });
    server.on("session", () => { sessionCount += 1; });
    server.on("request", (req, res) => {
      void gate.onRequest().then(() => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ver: req.httpVersion }));
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    base = `https://127.0.0.1:${typeof addr === "object" && addr ? addr.port : addr}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    if (TLS) rmSync(TLS.dir, { recursive: true, force: true });
  });

  it.skipIf(!TLS)("https + slotCount:6, spc:6 → ONE h2 session carries all 6 concurrent streams", async () => {
    sessionCount = 0; gate.arm(6);
    const t = createLoadTransport({ preferH2: true, slotCount: 6, streamsPerConnection: 6, connectOverrides: { rejectUnauthorized: false } });
    const results = await concurrentProbe(t.fetch as F, base, 6);
    await t.close();
    expect(sessionCount).toBe(1); // ceil(6/6) = 1 connection
    expect(results.every((r) => r.ver === "2.0")).toBe(true);
  });

  it.skipIf(!TLS)("https + slotCount:8, spc:2 → FOUR h2 sessions (the reuse ratio spreads streams)", async () => {
    sessionCount = 0; gate.arm(8);
    const t = createLoadTransport({ preferH2: true, slotCount: 8, streamsPerConnection: 2, connectOverrides: { rejectUnauthorized: false } });
    const results = await concurrentProbe(t.fetch as F, base, 8);
    await t.close();
    expect(sessionCount).toBe(4); // ceil(8/2) = 4 connections
    expect(results.every((r) => r.ver === "2.0")).toBe(true);
  });

  it.skipIf(!TLS)("preferH2:false → HTTP/1.1 even against an h2-capable server (allowH2 off)", async () => {
    sessionCount = 0; gate.arm(3);
    const t = createLoadTransport({ preferH2: false, slotCount: 3, streamsPerConnection: 5, connectOverrides: { rejectUnauthorized: false } });
    const results = await concurrentProbe(t.fetch as F, base, 3);
    await t.close();
    expect(results.every((r) => r.ver === "1.1")).toBe(true);
  });
});

describe("createLoadTransport — plain http (no TLS): auto-h1 + scheme-aware pool sizing", () => {
  let server: Server | undefined;
  let base = "";
  let connections = 0;
  const gate = makeGate();

  beforeAll(async () => {
    server = createServer((req, res) => {
      void gate.onRequest().then(() => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ver: req.httpVersion }));
      });
    });
    server.on("connection", () => { connections += 1; });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : addr}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
  });

  it("serves http:// over h1 even with preferH2:true (no ALPN on cleartext)", async () => {
    gate.arm(1);
    const t = createLoadTransport({ preferH2: true, slotCount: 1, streamsPerConnection: 5 });
    const res = (await (t.fetch as F)(new Request(`${base}/`))) as Response;
    const body = (await res.json()) as { ver: string };
    await t.close();
    expect(body.ver).toBe("1.1");
  });

  it("GET and POST(json) both round-trip through the injected fetch (Request normalization)", async () => {
    gate.arm(1);
    const t = createLoadTransport({ preferH2: true, slotCount: 2, streamsPerConnection: 5 });
    const f = t.fetch as F;
    const get = (await (await f(new Request(`${base}/g`))).json()) as { ver: string };
    const post = (await (
      await f(new Request(`${base}/p`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ a: 1 }) }))
    ).json()) as { ver: string };
    await t.close();
    expect(get.ver).toBe("1.1");
    expect(post.ver).toBe("1.1");
  });

  it("sizes the http pool to slotCount (NOT ceil(slotCount/spc)) — cleartext is never throttled", async () => {
    // preferH2:true + spc:5 would (wrongly) cap a single Agent at ceil(6/5)=2 connections; the
    // scheme-routed h1 pool must instead give 6 concurrent connections for a 6-slot http load.
    // The gate holds all 6 concurrently, so a throttled pool would DEADLOCK (only 2 arrive) —
    // this test both proves the count AND that http is not capped below slotCount.
    connections = 0; gate.arm(6);
    const t = createLoadTransport({ preferH2: true, slotCount: 6, streamsPerConnection: 5 });
    const results = await concurrentProbe(t.fetch as F, base, 6);
    await t.close();
    expect(connections).toBe(6); // one connection per concurrent request — not 2
    expect(results.every((r) => r.ver === "1.1")).toBe(true);
  });

  it("emits the plain-http ignore warning ONCE when routing http under an explicit spc>1", async () => {
    gate.arm(1);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = createLoadTransport({
      preferH2: true,
      slotCount: 2,
      streamsPerConnection: 5,
      httpIgnoreWarning: 'loadRunner "p": streamsPerConnection ignored for plain-http target (no multiplexing).',
    });
    const f = t.fetch as F;
    await (await f(new Request(`${base}/a`))).text();
    await (await f(new Request(`${base}/b`))).text();
    await t.close();
    // Read the recorded calls BEFORE mockRestore() (which resets the mock's call log).
    const hits = warn.mock.calls.filter((c) => String(c[0]).includes("plain-http target"));
    warn.mockRestore();
    expect(hits.length).toBe(1); // once, not per request
  });
});
