import { describe, it, expect, afterEach } from "vitest";

import { test } from "@glubean/sdk";

import { RunnerCore } from "../engine.js";
import { createNodeHost } from "../node-host.js";
import type { ExecutionEvent, RunnerServices } from "../types.js";

// ============================================================================
// GLU-81: engine:worker 内相对 URL 被按脚本目录绝对化,重锚后路径带残留前缀.
//
// A browser Web Worker gives `Request`/`URL` an IMPLICIT base — the worker
// SCRIPT's own URL — so `new Request("todos/1")` silently resolves against the
// worker's script directory (e.g. "/assets/todos/1"), never the intended API.
// ky 2 builds that Request internally (`new Request(input, options)`) before any
// hook or host `fetch` sees it, so by the time `request.url` is observable, the
// pollution is already baked in and unrecoverable from `request.url` alone (the
// F11 residual — cloud dd38fcc / GLU-46 comment).
//
// Node's global `Request` has NO implicit base (a bare relative string throws
// immediately — confirmed unchanged by the "plain Node, no polyfill" case below),
// so this suite polyfills `globalThis.Request` for the duration of each test to
// reproduce the Worker's implicit-base resolution and prove the engine still
// recovers the clean pre-absolutization URL despite it.
// ============================================================================

const traceEvents = (events: ExecutionEvent[]) =>
  events.filter((e): e is Extract<ExecutionEvent, { type: "trace" }> => e.type === "trace");

/** The worker SCRIPT's own URL — the implicit base a real Playground worker's
 *  `Request` would resolve a bare relative path against (pollution source). */
const WORKER_SCRIPT_URL = "https://app.example.com/assets/worker-abc123.js";

/** Install a `Request` polyfill that mimics a Web Worker's implicit-base
 *  resolution (Node's native `Request` has none — it throws on a bare relative
 *  string instead). Returns a restore function. */
function installWorkerLikeRequest(): () => void {
  const NativeRequest = globalThis.Request;
  class WorkerLikeRequest extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      if (typeof input === "string" && !/^[a-z][a-z0-9+.-]*:/i.test(input) && !input.startsWith("//")) {
        super(new URL(input, WORKER_SCRIPT_URL).toString(), init);
      } else {
        super(input, init);
      }
    }
  }
  globalThis.Request = WorkerLikeRequest as unknown as typeof Request;
  return () => {
    globalThis.Request = NativeRequest;
  };
}

describe("engine http — GLU-81 worker relative-URL capture", () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it("Node (no implicit base): a bare relative URL throws immediately — unchanged, still a loud failure", async () => {
    const host = createNodeHost();
    const engine = new RunnerCore(host.services);
    const ns = {
      t: test("bare-relative-node", async (ctx) => {
        await ctx.http.get("todos/1");
      }),
    };
    const [def] = engine.resolve(ns);
    const res = await engine.run(def!);
    expect(res.status).toBe("error");
    expect(res.error).toMatch(/Failed to parse URL|Invalid URL/i);
  });

  it("simulated Worker: request.url gets polluted by the script directory, but trace.requestedUrl recovers the clean relative form", async () => {
    restore = installWorkerLikeRequest();
    let seenNonRequestOptions: Record<string, unknown> | undefined;
    const fetchImpl: RunnerServices["fetch"] = async (_input, init) => {
      seenNonRequestOptions = init as Record<string, unknown> | undefined;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const host = createNodeHost({ fetch: fetchImpl });
    const engine = new RunnerCore(host.services);
    const ns = {
      t: test("bare-relative-worker", async (ctx) => {
        await ctx.http.get("todos/1").json();
      }),
    };
    const [def] = engine.resolve(ns);
    const res = await engine.run(def!);
    expect(res.status).toBe("ok");

    const traces = traceEvents(host.events);
    expect(traces).toHaveLength(1);
    // Proves the simulated bug is real: request.url picked up the worker script's
    // OWN directory ("/assets"), not the author's intended path.
    expect(traces[0]!.data.url).toBe(`${WORKER_SCRIPT_URL.replace(/\/[^/]*$/, "")}/todos/1`);
    // ...yet the clean pre-absolutization form survived on the trace (what a
    // re-anchoring host reads instead of the polluted request.url).
    expect(traces[0]!.data.requestedUrl).toBe("todos/1");
    // ...and reached the host fetch's forwarded (non-Request) options too — the
    // channel a browser host adapter (e.g. the Playground worker's postMessage
    // proxy) would read from to forward it to the reanchor logic (GLU-81 cloud
    // scope, not implemented here).
    expect(seenNonRequestOptions?.glubeanRawUrl).toBe("todos/1");
  });

  it("an absolute URL string is left alone — no requestedUrl captured (nothing to recover)", async () => {
    const fetchImpl: RunnerServices["fetch"] = async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    const host = createNodeHost({ fetch: fetchImpl });
    const engine = new RunnerCore(host.services);
    const ns = {
      t: test("absolute", async (ctx) => {
        await ctx.http.get("https://api.example.com/todos/1").json();
      }),
    };
    const [def] = engine.resolve(ns);
    const res = await engine.run(def!);
    expect(res.status).toBe("ok");
    const traces = traceEvents(host.events);
    expect(traces).toHaveLength(1);
    expect(traces[0]!.data.requestedUrl).toBeUndefined();
  });
});
