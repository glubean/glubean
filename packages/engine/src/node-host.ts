/**
 * NodeHost — the Node implementation of the engine's host ports (Stage 1 B4 ③).
 *
 * node-only (it uses node global fetch + the ALS carrier, which is backed by
 * node:async_hooks). NOT imported by the host-agnostic core (index.ts); a browser
 * bundle of the engine never pulls this in. The eventual home is @glubean/runner;
 * during the spike it lives here so the node-parity test can drive the engine
 * through a real node host (real fetch, real clock, real ALS isolation).
 */
import { createAlsCarrier } from "@glubean/sdk/internal";

import type { EnvProvider, ExecutionEvent, FetchImpl, RunnerServices } from "./types.js";

export interface NodeHost {
  services: RunnerServices;
  /** Events collected from the run(s) — node would instead stream these to stdout. */
  events: ExecutionEvent[];
}

export interface NodeHostOptions {
  vars?: Record<string, string>;
  secrets?: Record<string, string>;
  /** Override the egress fetch (defaults to node global fetch). */
  fetch?: FetchImpl;
}

export function createNodeHost(opts: NodeHostOptions = {}): NodeHost {
  const events: ExecutionEvent[] = [];
  const env: EnvProvider = {
    vars: () => opts.vars ?? {},
    secrets: () => opts.secrets ?? {},
  };
  const services: RunnerServices = {
    fetch: opts.fetch ?? ((input, init) => globalThis.fetch(input as RequestInfo, init)),
    env,
    events: { emit: (e) => events.push(e) },
    scheduler: { now: () => performance.now() },
    // ALS carrier = true per-run isolation across awaits in node (the same carrier
    // the SDK installs by default). The headline gate proved the engine delegates
    // isolation entirely to this port.
    carrier: createAlsCarrier(),
  };
  return { services, events };
}
