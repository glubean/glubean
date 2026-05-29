/**
 * Tests for the resolved-config helpers in lib/config.ts that survive the
 * config consolidation (docs/06): `resolveRedactionConfig` (now the only
 * way redaction is resolved — from glubean.yaml `defaults.redaction`) and
 * `mergeRunOptions`. The legacy package.json flat-shape loader and its
 * helpers (loadConfig / readSingleConfig / mergeConfigInputs) were removed.
 */

import { test, expect } from "vitest";
import { mergeRunOptions, resolveRedactionConfig, RUN_DEFAULTS } from "./config.js";

// ═════════════════════════════════════════════════════════════════════════════
// resolveRedactionConfig — compiles + redacts end-to-end
// ═════════════════════════════════════════════════════════════════════════════

test("resolveRedactionConfig: default config redacts built-in sensitive keys", async () => {
  const { compileScopes, redactEvent, BUILTIN_SCOPES } = await import("@glubean/redaction");
  const redaction = resolveRedactionConfig(undefined);
  expect(redaction.replacementFormat).toBe("partial");
  expect(redaction.scopes.length).toBeGreaterThan(0);

  const compiled = compileScopes({
    builtinScopes: BUILTIN_SCOPES,
    globalRules: redaction.globalRules,
    replacementFormat: redaction.replacementFormat,
  });
  const event = {
    type: "trace",
    data: { requestHeaders: { authorization: "Bearer secret-token-12345" } },
  };
  const redacted = redactEvent(event, compiled, redaction.replacementFormat);
  const headers = (redacted.data as Record<string, unknown>).requestHeaders as Record<string, unknown>;
  expect(headers.authorization).not.toBe("Bearer secret-token-12345");
});

test("resolveRedactionConfig: user sensitiveKeys redact in request body", async () => {
  const { compileScopes, redactEvent, BUILTIN_SCOPES } = await import("@glubean/redaction");
  const redaction = resolveRedactionConfig({ sensitiveKeys: ["x-custom-secret"] });

  const compiled = compileScopes({
    builtinScopes: BUILTIN_SCOPES,
    globalRules: redaction.globalRules,
    replacementFormat: redaction.replacementFormat,
  });
  const event = {
    type: "trace",
    data: { requestBody: { "x-custom-secret": "hidden", username: "alice" } },
  };
  const redacted = redactEvent(event, compiled, redaction.replacementFormat);
  const body = (redacted.data as Record<string, unknown>).requestBody as Record<string, unknown>;
  expect(body["x-custom-secret"]).not.toBe("hidden");
  expect(body.username).toBe("alice");
});

test("resolveRedactionConfig: custom patterns redact matching text", async () => {
  const { compileScopes, redactEvent, BUILTIN_SCOPES } = await import("@glubean/redaction");
  const redaction = resolveRedactionConfig({
    customPatterns: [{ name: "internal-id", regex: "INT-[A-Z0-9]{8}" }],
  });

  const compiled = compileScopes({
    builtinScopes: BUILTIN_SCOPES,
    globalRules: redaction.globalRules,
    replacementFormat: redaction.replacementFormat,
  });
  const event = { type: "log", message: "Processing INT-ABCD1234 for user" };
  const redacted = redactEvent(event, compiled, redaction.replacementFormat);
  expect(redacted.message).not.toContain("INT-ABCD1234");
});

test("redactEvent: passes through non-matching event types by reference", async () => {
  const { compileScopes, redactEvent, BUILTIN_SCOPES } = await import("@glubean/redaction");
  const redaction = resolveRedactionConfig(undefined);
  const compiled = compileScopes({
    builtinScopes: BUILTIN_SCOPES,
    globalRules: redaction.globalRules,
    replacementFormat: redaction.replacementFormat,
  });
  const event = { type: "metric", name: "duration", value: 42 };
  const result = redactEvent(event, compiled, redaction.replacementFormat);
  expect(result).toBe(event); // same reference, no clone
});

test("redactEvent: does not mutate the original event", async () => {
  const { compileScopes, redactEvent, BUILTIN_SCOPES } = await import("@glubean/redaction");
  const redaction = resolveRedactionConfig(undefined);
  const compiled = compileScopes({
    builtinScopes: BUILTIN_SCOPES,
    globalRules: redaction.globalRules,
    replacementFormat: redaction.replacementFormat,
  });
  const event = {
    type: "trace",
    data: { requestHeaders: { authorization: "Bearer secret" } },
  };
  redactEvent(event, compiled, redaction.replacementFormat);
  expect((event.data.requestHeaders as any).authorization).toBe("Bearer secret");
});

// ═════════════════════════════════════════════════════════════════════════════
// mergeRunOptions
// ═════════════════════════════════════════════════════════════════════════════

test("mergeRunOptions: CLI flags override config", () => {
  const config = { ...RUN_DEFAULTS, verbose: false, pretty: true };
  const result = mergeRunOptions(config, { verbose: true, pretty: false });
  expect(result.verbose).toBe(true);
  expect(result.pretty).toBe(false);
  expect(result.logFile).toBe(RUN_DEFAULTS.logFile);
  expect(result.emitFullTrace).toBe(RUN_DEFAULTS.emitFullTrace);
});

test("mergeRunOptions: undefined CLI flags preserve config", () => {
  const config = { ...RUN_DEFAULTS, verbose: true, pretty: false, failFast: true };
  const result = mergeRunOptions(config, {});
  expect(result.verbose).toBe(true);
  expect(result.pretty).toBe(false);
  expect(result.failFast).toBe(true);
});

test("mergeRunOptions: failAfter number", () => {
  const result = mergeRunOptions(RUN_DEFAULTS, { failAfter: 5 });
  expect(result.failAfter).toBe(5);
});

test("mergeRunOptions: envFile override", () => {
  const result = mergeRunOptions(RUN_DEFAULTS, { envFile: ".env.staging" });
  expect(result.envFile).toBe(".env.staging");
});
