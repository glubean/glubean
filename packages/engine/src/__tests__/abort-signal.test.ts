import { describe, it, expect, vi } from "vitest";

import { createAlsCarrier } from "@glubean/sdk/internal";

import { RunnerCore } from "../engine.js";
import type { GlubeanHttp, RunnerServices, TestDef } from "../types.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function services(fetchImpl: RunnerServices["fetch"], abortMode?: "precise" | "coarse"): RunnerServices {
  return {
    fetch: fetchImpl,
    env: { vars: () => ({}), secrets: () => ({}) },
    events: { emit: () => {} },
    scheduler: { now: () => 0 },
    carrier: createAlsCarrier(),
    ...(abortMode ? { http: { abortMode } } : {}),
  };
}

/** A TestDef whose steps each fire one `ctx.http.get`. */
function httpDef(url: string, steps = 1): TestDef {
  return {
    meta: { id: "t" },
    type: "steps",
    steps: Array.from({ length: steps }, (_, i) => ({
      meta: { name: `s${i}` },
      fn: async (ctx: unknown) => {
        await (ctx as { http: GlubeanHttp }).http.get(url);
      },
    })),
  };
}

// The engine hands ky the run-level abort signal so an aborted run cancels in-flight
// HTTP — but via a leak-free per-iteration bridge (one listener on the long-lived run
// signal, removed when the run settles), NOT a fresh per-request listener (the load
// throughput footgun). `abortMode: "coarse"` opts out of the wiring entirely.
describe("engine — run-abort signal wiring", () => {
  it("precise (default): aborting the run cancels the in-flight request", async () => {
    const captured: { signal?: AbortSignal } = {};
    const fetchImpl: RunnerServices["fetch"] = (input) => {
      const req = input as Request;
      captured.signal = req.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        const s = req.signal;
        if (s?.aborted) return reject(new DOMException("Aborted", "AbortError"));
        s?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        // otherwise never settles — only the abort path resolves this request
      });
    };
    const runController = new AbortController();
    const p = new RunnerCore(services(fetchImpl)).run(httpDef("http://api.test/x"), {
      signal: runController.signal,
    });
    await sleep(20); // let the request go in-flight
    expect(captured.signal).toBeDefined();
    expect(captured.signal!.aborted).toBe(false);

    runController.abort();
    await p;
    expect(captured.signal!.aborted).toBe(true); // in-flight request was cancelled
  });

  it("coarse: the run signal is NOT wired into the request", async () => {
    const captured: { signal?: AbortSignal } = {};
    let resolveFetch!: (r: Response) => void;
    const fetchImpl: RunnerServices["fetch"] = (input) => {
      captured.signal = (input as Request).signal ?? undefined;
      return new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
    };
    const runController = new AbortController();
    const p = new RunnerCore(services(fetchImpl, "coarse")).run(httpDef("http://api.test/x"), {
      signal: runController.signal,
    });
    await sleep(20);
    runController.abort();
    await sleep(10);
    // Aborting the run must not abort the request — coarse never wires the run signal in.
    expect(captured.signal?.aborted ?? false).toBe(false);

    resolveFetch(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    await p;
  });

  it("precise: one bridge listener per iteration, removed after the run (no per-request leak)", async () => {
    // Default fetch resolves immediately, so both http calls complete normally.
    const fetchImpl: RunnerServices["fetch"] = async () =>
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    const runController = new AbortController();
    const addSpy = vi.spyOn(runController.signal, "addEventListener");
    const removeSpy = vi.spyOn(runController.signal, "removeEventListener");

    await new RunnerCore(services(fetchImpl)).run(httpDef("http://api.test/x", 2), {
      signal: runController.signal,
    });

    const adds = addSpy.mock.calls.filter((c) => c[0] === "abort").length;
    const removes = removeSpy.mock.calls.filter((c) => c[0] === "abort").length;
    // ONE bridge listener for the whole iteration (two requests) — not one per request —
    // and it is removed when the run settles.
    expect(adds).toBe(1);
    expect(removes).toBe(1);
  });

  it("precise: ctx.http.extend() clients share the bridge — still one listener (codex P2)", async () => {
    const fetchImpl: RunnerServices["fetch"] = async () =>
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    const def: TestDef = {
      meta: { id: "t" },
      type: "steps",
      steps: [
        {
          meta: { name: "s0" },
          fn: async (ctx: unknown) => {
            await (ctx as { http: { extend: (o: unknown) => GlubeanHttp } }).http
              .extend({ prefixUrl: "http://api.test/v1" })
              .get("a");
          },
        },
        {
          meta: { name: "s1" },
          fn: async (ctx: unknown) => {
            await (ctx as { http: { extend: (o: unknown) => GlubeanHttp } }).http
              .extend({ prefixUrl: "http://api.test/v2" })
              .get("b");
          },
        },
      ],
    };
    const runController = new AbortController();
    const addSpy = vi.spyOn(runController.signal, "addEventListener");
    const removeSpy = vi.spyOn(runController.signal, "removeEventListener");

    await new RunnerCore(services(fetchImpl)).run(def, { signal: runController.signal });

    // Each extend() makes a fresh ky proxy; the bridge lives on the scope, so still ONE
    // listener on the run signal (not one per extended client) — and removed at settle.
    expect(addSpy.mock.calls.filter((c) => c[0] === "abort").length).toBe(1);
    expect(removeSpy.mock.calls.filter((c) => c[0] === "abort").length).toBe(1);
  });

  it("precise: a request still in flight when the run settles is cancelled (codex P2)", async () => {
    const captured: { signal?: AbortSignal } = {};
    const fetchImpl: RunnerServices["fetch"] = (input) => {
      captured.signal = (input as Request).signal ?? undefined;
      return new Promise<Response>(() => {}); // never settles on its own
    };
    // A short step timeout races the hanging request; the step times out while the ky call
    // is still in flight, then the run settles. Teardown must cancel the straggler.
    const def: TestDef = {
      meta: { id: "t" },
      type: "steps",
      steps: [
        {
          meta: { name: "s", timeout: 20 },
          fn: async (ctx: unknown) => {
            await (ctx as { http: GlubeanHttp }).http.get("http://api.test/x");
          },
        },
      ],
    };
    const runController = new AbortController();
    await new RunnerCore(services(fetchImpl)).run(def, { signal: runController.signal });

    // The run settled (step timed out) but the underlying request was still in flight —
    // disposeHttp must have aborted the bridge so the straggler does not leak.
    expect(captured.signal).toBeDefined();
    expect(captured.signal!.aborted).toBe(true);
  });
});
