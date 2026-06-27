import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";

import { test, configure } from "@glubean/sdk";

import { RunnerCore } from "../engine.js";
import { createNodeHost } from "../node-host.js";
import type { ExecutionEvent } from "../types.js";

// Stage 1 ①③: drive the engine through a REAL NodeHost (node global fetch, real
// clock, ALS carrier) against a REAL local HTTP server — proving the engine + ky2
// reproduce node behavior end-to-end for the narrow set (simple / builder / each /
// assertion-fail + http trace + configure().http prefix). Deterministic (local
// server), unlike the httpbin-backed runner session tests.

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/204") {
      res.writeHead(204).end();
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ path: url.pathname, method: req.method, body: body || null }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : addr}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

const traceEvents = (events: ExecutionEvent[]) =>
  events.filter((e): e is Extract<ExecutionEvent, { type: "trace" }> => e.type === "trace");

describe("node parity — engine + real NodeHost over a local server", () => {
  it("simple test: real http round-trip + assertion + attributed trace", async () => {
    const host = createNodeHost();
    const engine = new RunnerCore(host.services);
    const ns = {
      t: test("simple", async (ctx) => {
        const r = (await ctx.http.get(`${base}/ping`).json()) as { path: string };
        ctx.expect(r.path).toBe("/ping");
      }),
    };
    const [def] = engine.resolve(ns);
    const res = await engine.run(def!);
    expect(res.status).toBe("ok");
    expect(res.assertions).toEqual({ total: 1, passed: 1 });
    const traces = traceEvents(host.events);
    expect(traces).toHaveLength(1);
    // Rich Trace shape (Phase 4f): the HTTP fields live under `data`.
    expect(traces[0]).toMatchObject({ id: "simple", data: { method: "GET", status: 200, ok: true, protocol: "http" } });
    expect(traces[0]!.data.url).toContain("/ping");
    expect(traces[0]!.data.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("builder steps: setup → http step (state threads) → assert step → teardown", async () => {
    const host = createNodeHost();
    const engine = new RunnerCore(host.services);
    const order: string[] = [];
    const ns = {
      t: test("builder")
        .step("fetch", async (ctx) => {
          order.push("fetch");
          const r = (await ctx.http.get(`${base}/users`).json()) as { path: string };
          return { seen: r.path };
        })
        .step("assert", async (ctx, state) => {
          order.push("assert");
          ctx.expect((state as { seen: string }).seen).toBe("/users");
        }),
    };
    const [def] = engine.resolve(ns);
    const res = await engine.run(def!);
    expect(res.status).toBe("ok");
    expect(order).toEqual(["fetch", "assert"]);
    expect(traceEvents(host.events)).toHaveLength(1);
  });

  it("test.each: each row makes its own request + assertion", async () => {
    const host = createNodeHost();
    const engine = new RunnerCore(host.services);
    const ns = {
      rows: test.each([{ name: "a" }, { name: "b" }])("$name", async (ctx, row) => {
        const r = (await ctx.http.get(`${base}/${row.name}`).json()) as { path: string };
        ctx.expect(r.path).toBe(`/${row.name}`);
      }),
    };
    const results = await Promise.all(engine.resolve(ns).map((d) => engine.run(d)));
    expect(Object.fromEntries(results.map((r) => [r.id, r.status]))).toEqual({ a: "ok", b: "ok" });
  });

  it("assertion failure → status error", async () => {
    const host = createNodeHost();
    const engine = new RunnerCore(host.services);
    const ns = {
      t: test("fail", async (ctx) => {
        const r = (await ctx.http.get(`${base}/ping`).json()) as { path: string };
        ctx.expect(r.path).toBe("/WRONG");
      }),
    };
    const [def] = engine.resolve(ns);
    const res = await engine.run(def!);
    expect(res.status).toBe("error");
    expect(res.assertions).toEqual({ total: 1, passed: 0 });
  });

  it("ctx.when: only the taken arm runs (if/else parity)", async () => {
    const host = createNodeHost();
    const engine = new RunnerCore(host.services);
    const ns = {
      t: test("when", async (ctx) => {
        const r = (await ctx.http.get(`${base}/ping`).json()) as { path: string };
        await ctx.when(
          r.path === "/ping",
          () => ctx.expect(r.path).toBe("/ping"),
          () => ctx.expect(r.path).toBe("/never"),
        );
      }),
    };
    const [def] = engine.resolve(ns);
    const res = await engine.run(def!);
    expect(res.status).toBe("ok");
    // Only the then-arm ran → exactly one (passing) assertion.
    expect(res.assertions).toEqual({ total: 1, passed: 1 });
  });

  it("ctx.switch: first truthy lazy guard wins and short-circuits", async () => {
    const host = createNodeHost();
    const engine = new RunnerCore(host.services);
    const calls: string[] = [];
    const ns = {
      t: test("switch", async (ctx) => {
        const r = (await ctx.http.get(`${base}/ping`).json()) as { path: string };
        await ctx.switch(
          [
            {
              when: () => {
                calls.push("g0");
                return r.path === "/ping";
              },
              then: () => ctx.expect(r.path).toBe("/ping"),
            },
            {
              when: () => {
                calls.push("g1");
                return true;
              },
              then: () => ctx.expect(r.path).toBe("/never"),
            },
          ],
          () => ctx.expect(r.path).toBe("/default"),
        );
      }),
    };
    const [def] = engine.resolve(ns);
    const res = await engine.run(def!);
    expect(res.status).toBe("ok");
    expect(res.assertions).toEqual({ total: 1, passed: 1 });
    // Short-circuit: the second guard was never evaluated.
    expect(calls).toEqual(["g0"]);
  });

  it("configure().http prefixUrl resolves against the server (prefixUrl→prefix)", async () => {
    const host = createNodeHost();
    const engine = new RunnerCore(host.services);
    const api = configure({ http: { prefixUrl: base } });
    const ns = {
      t: test("cfg", async (ctx) => {
        const r = (await api.http.get("ping").json()) as { path: string };
        ctx.expect(r.path).toBe("/ping");
      }),
    };
    const [def] = engine.resolve(ns);
    const res = await engine.run(def!);
    expect(res.status).toBe("ok");
    expect(traceEvents(host.events)[0]!.data.url).toBe(`${base}/ping`);
  });
});
