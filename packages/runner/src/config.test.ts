import { test, expect } from "vitest";
import {
  LOCAL_RUN_DEFAULTS,
  SHARED_RUN_DEFAULTS,
  toExecutionOptions,
  toSingleExecutionOptions,
  WORKER_RUN_DEFAULTS,
} from "./config.js";
import type { SharedRunConfig } from "./config.js";

// --- Presets ---

test("SHARED_RUN_DEFAULTS has expected values", () => {
  expect(SHARED_RUN_DEFAULTS.failFast).toBe(false);
  expect(SHARED_RUN_DEFAULTS.perTestTimeoutMs).toBe(30_000);
  expect(SHARED_RUN_DEFAULTS.concurrency).toBe(1);
  expect(SHARED_RUN_DEFAULTS.emitFullTrace).toBe(false);
});

test("LOCAL_RUN_DEFAULTS extends shared defaults", () => {
  expect(LOCAL_RUN_DEFAULTS.failFast).toBe(false);
  expect(LOCAL_RUN_DEFAULTS.perTestTimeoutMs).toBe(30_000);
});

test("WORKER_RUN_DEFAULTS has longer timeout", () => {
  expect(WORKER_RUN_DEFAULTS.perTestTimeoutMs).toBe(300_000);
});

// --- toExecutionOptions ---

test("toExecutionOptions maps failFast to stopOnFailure", () => {
  const shared: SharedRunConfig = {
    ...SHARED_RUN_DEFAULTS,
    failFast: true,
    concurrency: 4,
    failAfter: 3,
  };
  const opts = toExecutionOptions(shared);
  expect(opts.stopOnFailure).toBe(true);
  expect(opts.concurrency).toBe(4);
  expect(opts.failAfter).toBe(3);
});

test("toExecutionOptions allows extra overrides", () => {
  const opts = toExecutionOptions(SHARED_RUN_DEFAULTS, { concurrency: 8 });
  expect(opts.concurrency).toBe(8);
  expect(opts.stopOnFailure).toBe(false);
});

// --- toSingleExecutionOptions ---

test("toSingleExecutionOptions wires perTestTimeoutMs", () => {
  const shared: SharedRunConfig = {
    ...SHARED_RUN_DEFAULTS,
    perTestTimeoutMs: 60_000,
  };
  const opts = toSingleExecutionOptions(shared);
  expect(opts.timeout).toBe(60_000);
});

test("toSingleExecutionOptions allows extra overrides", () => {
  const opts = toSingleExecutionOptions(SHARED_RUN_DEFAULTS, {
    timeout: 5_000,
  });
  expect(opts.timeout).toBe(5_000);
});
