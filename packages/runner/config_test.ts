import { assertEquals } from "@std/assert";
import {
  LOCAL_RUN_DEFAULTS,
  resolveAllowNetFlag,
  SHARED_RUN_DEFAULTS,
  toExecutionOptions,
  toSingleExecutionOptions,
  WORKER_RUN_DEFAULTS,
} from "./config.ts";
import type { SharedRunConfig } from "./config.ts";

// --- resolveAllowNetFlag ---

Deno.test("resolveAllowNetFlag: '*' returns unrestricted flag", () => {
  assertEquals(resolveAllowNetFlag("*"), "--allow-net");
});

Deno.test("resolveAllowNetFlag: empty string returns null (no network)", () => {
  assertEquals(resolveAllowNetFlag(""), null);
});

Deno.test("resolveAllowNetFlag: host list returns scoped flag", () => {
  assertEquals(
    resolveAllowNetFlag("api.example.com,db:5432"),
    "--allow-net=api.example.com,db:5432",
  );
});

Deno.test("resolveAllowNetFlag: trims whitespace in hosts", () => {
  assertEquals(
    resolveAllowNetFlag("  host1 , host2  , host3  "),
    "--allow-net=host1,host2,host3",
  );
});

Deno.test("resolveAllowNetFlag: single host", () => {
  assertEquals(
    resolveAllowNetFlag("api.example.com"),
    "--allow-net=api.example.com",
  );
});

Deno.test("resolveAllowNetFlag: only whitespace/commas returns null (fail-closed)", () => {
  assertEquals(resolveAllowNetFlag("  ,  , "), null);
});

// --- Presets ---

Deno.test("SHARED_RUN_DEFAULTS has minimal permissions", () => {
  assertEquals(SHARED_RUN_DEFAULTS.permissions, ["--allow-read"]);
  assertEquals(SHARED_RUN_DEFAULTS.allowNet, "*");
  assertEquals(SHARED_RUN_DEFAULTS.failFast, false);
  assertEquals(SHARED_RUN_DEFAULTS.perTestTimeoutMs, 30_000);
  assertEquals(SHARED_RUN_DEFAULTS.concurrency, 1);
  assertEquals(SHARED_RUN_DEFAULTS.emitFullTrace, false);
});

Deno.test("LOCAL_RUN_DEFAULTS adds --allow-env", () => {
  assertEquals(LOCAL_RUN_DEFAULTS.permissions, [
    "--allow-read",
    "--allow-env",
  ]);
});

Deno.test("WORKER_RUN_DEFAULTS has no --allow-env and longer timeout", () => {
  assertEquals(WORKER_RUN_DEFAULTS.permissions, ["--allow-read"]);
  assertEquals(WORKER_RUN_DEFAULTS.perTestTimeoutMs, 300_000);
});

// --- toExecutionOptions ---

Deno.test("toExecutionOptions maps failFast to stopOnFailure", () => {
  const shared: SharedRunConfig = {
    ...SHARED_RUN_DEFAULTS,
    failFast: true,
    concurrency: 4,
    failAfter: 3,
  };
  const opts = toExecutionOptions(shared);
  assertEquals(opts.stopOnFailure, true);
  assertEquals(opts.concurrency, 4);
  assertEquals(opts.failAfter, 3);
});

Deno.test("toExecutionOptions allows extra overrides", () => {
  const opts = toExecutionOptions(SHARED_RUN_DEFAULTS, { concurrency: 8 });
  assertEquals(opts.concurrency, 8);
  assertEquals(opts.stopOnFailure, false);
});

// --- toSingleExecutionOptions ---

Deno.test("toSingleExecutionOptions wires perTestTimeoutMs", () => {
  const shared: SharedRunConfig = {
    ...SHARED_RUN_DEFAULTS,
    perTestTimeoutMs: 60_000,
  };
  const opts = toSingleExecutionOptions(shared);
  assertEquals(opts.timeout, 60_000);
});

Deno.test("toSingleExecutionOptions allows extra overrides", () => {
  const opts = toSingleExecutionOptions(SHARED_RUN_DEFAULTS, {
    timeout: 5_000,
  });
  assertEquals(opts.timeout, 5_000);
});
