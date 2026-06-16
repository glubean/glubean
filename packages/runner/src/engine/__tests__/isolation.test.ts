import { describe, it, expect } from "vitest";

import { configure, session } from "@glubean/sdk";
import { createAlsCarrier, createGlobalThisCarrier, type RuntimeCarrier } from "@glubean/sdk/internal";

import { RunnerCore } from "../engine.js";
import type { ExecutionEvent, RunnerServices, TestDef, Transport } from "../types.js";

// ============================================================================
// Stage 1 HEADLINE go/no-go (SoT 0003 §5 Stage 1 / plan §B2,B5).
//
// Prove the engine expresses per-run isolation using ONLY the injected Carrier
// port + an explicit ExecutionScope, with no module-global coupling. Each run,
// AFTER an http await (the interleave point), reads the three SDK global
// getRuntime() consumers codex flagged as the real risk — configure().vars,
// session.get(), configure().http (prefix) — which is exactly what a single-slot
// carrier crosses.
//
//   ALS carrier            → two interleaved runs never cross (GO signal).
//   globalThis single-slot → the SAME test LEAKS (negative control: proves the
//                            test is sensitive to carrier leakage; not a tautology).
// ============================================================================

// Barrier transport: the first request from each party parks until all parties
// have arrived, then all proceed — forcing two runs to interleave at their first
// await. Later requests pass straight through. Echoes the request url in the body.
function makeBarrierTransport(parties: number): Transport {
  let arrived = 0;
  let open = false;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  return {
    request: async (req) => {
      if (!open) {
        arrived += 1;
        if (arrived >= parties) {
          open = true;
          release();
        }
        await gate;
      }
      return { status: 200, headers: [], body: JSON.stringify({ url: req.url }) };
    },
  };
}

interface Obs {
  ctxWho?: string; // scope-bound (reliable regardless of carrier)
  cfgVarsWho?: unknown; // configure().vars — global getRuntime()
  sessWho?: unknown; // session.get() — global getRuntime()
  cfgHttpUrl?: string; // configure().http prefix — global getRuntime()
}

function makeServices(carrier: RuntimeCarrier, transport: Transport): RunnerServices {
  const events: ExecutionEvent[] = [];
  return {
    transport,
    env: { vars: () => ({}), secrets: () => ({}) },
    events: { emit: (e) => events.push(e) },
    scheduler: { now: () => 0 },
    carrier,
  };
}

function observingDef(id: string, obs: Record<string, Obs>): TestDef {
  return {
    meta: { id },
    type: "simple",
    fn: async (ctx) => {
      const own = ctx.vars.require("WHO"); // scope-bound self-id anchor
      obs[own] = { ctxWho: own };
      await ctx.http("https://base.test/ping"); // <-- interleave barrier
      // Everything below reads through the GLOBAL carrier (getRuntime()):
      const cfg = configure({ vars: { who: "{{WHO}}" }, http: { prefixUrl: "https://{{WHO}}.test" } });
      obs[own].cfgVarsWho = (cfg.vars as { who: string }).who;
      obs[own].sessWho = session.get("who");
      const r = (await cfg.http.get("x").json()) as { url: string };
      obs[own].cfgHttpUrl = r.url;
    },
  };
}

async function runTwoInterleaved(carrier: RuntimeCarrier): Promise<Record<string, Obs>> {
  const obs: Record<string, Obs> = {};
  const engine = new RunnerCore(makeServices(carrier, makeBarrierTransport(2)));
  await Promise.all([
    engine.run(observingDef("A", obs), { vars: { WHO: "A" }, session: { who: "A" } }),
    engine.run(observingDef("B", obs), { vars: { WHO: "B" }, session: { who: "B" } }),
  ]);
  return obs;
}

describe("engine isolation gate — two interleaved async runs", () => {
  it("ALS carrier: scopes never cross (vars / session / configured-http all own)", async () => {
    const obs = await runTwoInterleaved(createAlsCarrier());
    expect(obs.A.ctxWho).toBe("A");
    expect(obs.B.ctxWho).toBe("B");
    expect(obs.A.cfgVarsWho).toBe("A");
    expect(obs.B.cfgVarsWho).toBe("B");
    expect(obs.A.sessWho).toBe("A");
    expect(obs.B.sessWho).toBe("B");
    expect(obs.A.cfgHttpUrl).toBe("https://A.test/x");
    expect(obs.B.cfgHttpUrl).toBe("https://B.test/x");
  });

  it("NEGATIVE CONTROL — globalThis single-slot carrier LEAKS (test is sensitive)", async () => {
    const obs = await runTwoInterleaved(createGlobalThisCarrier());
    // Scope-bound ctx is correct regardless of carrier (proves ctx isolation):
    expect(obs.A.ctxWho).toBe("A");
    expect(obs.B.ctxWho).toBe("B");
    // But the global getRuntime() consumers cross under a single slot: NOT all own.
    const allOwn =
      obs.A.cfgVarsWho === "A" &&
      obs.B.cfgVarsWho === "B" &&
      obs.A.sessWho === "A" &&
      obs.B.sessWho === "B" &&
      obs.A.cfgHttpUrl === "https://A.test/x" &&
      obs.B.cfgHttpUrl === "https://B.test/x";
    expect(allOwn).toBe(false);
  });
});
