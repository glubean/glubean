/**
 * Poll primitives — bound validation + the quarantined-ctx buffer. The poll
 * LOOP itself is the vNext workflow's (execute.test.ts); the legacy flow
 * runtime/projection tests that lived here were deleted with the flow
 * (Nv1-D2).
 */
import { describe, expect, test } from "vitest";
import {
  validatePollBounds,
  PollExhaustedError,
  quarantinedCtx,
} from "./poll-primitives.js";
import type { TestContext } from "./types.js";

const ctx = { log: () => {} } as unknown as TestContext;
// ── bound validation ─────────────────────────────────────────────────────────

describe("validatePollBounds", () => {
  test("accepts timeout-only", () => {
    expect(() => validatePollBounds({ timeout: 1000 }, "p")).not.toThrow();
  });
  test("accepts maxAttempts + perAttemptTimeout", () => {
    expect(() => validatePollBounds({ maxAttempts: 5, perAttemptTimeout: 100 }, "p")).not.toThrow();
  });
  test("rejects no stop condition", () => {
    expect(() => validatePollBounds({ perAttemptTimeout: 100 }, "p")).toThrow(/stop condition/);
  });
  test("rejects maxAttempts-only (no per-attempt budget)", () => {
    expect(() => validatePollBounds({ maxAttempts: 5 }, "p")).toThrow(/not bounded/);
  });
  test("rejects Infinity timeout", () => {
    expect(() => validatePollBounds({ timeout: Infinity }, "p")).toThrow(/finite/);
  });
  test("rejects Infinity maxAttempts", () => {
    expect(() => validatePollBounds({ maxAttempts: Infinity, perAttemptTimeout: 100 }, "p")).toThrow(/finite/);
  });
  test("rejects Infinity every", () => {
    expect(() => validatePollBounds({ timeout: 1000, every: Infinity }, "p")).toThrow(/finite/);
  });
  test("rejects non-integer maxAttempts", () => {
    expect(() => validatePollBounds({ maxAttempts: 2.5, perAttemptTimeout: 100 }, "p")).toThrow(/integer/);
  });
});

// ── quarantine ──────────────────────────────────────────────────────────────

describe("quarantinedCtx", () => {
  test("buffers assert until flushed; hasFailure reflects a buffered failure", () => {
    const seen: Array<{ msg?: string }> = [];
    const real = {
      assert: (a: any, msg?: string) => seen.push({ msg }),
      log: () => {},
    } as unknown as TestContext;
    const q = quarantinedCtx(real);
    q.assert(false, "boom");
    expect(seen).toHaveLength(0); // buffered, not emitted
    expect(q.hasFailure()).toBe(true);
    q.flushTo(real);
    expect(seen).toEqual([{ msg: "boom" }]);
  });

  test("discarded buffer (no flush) never reaches the real ctx", () => {
    const seen: string[] = [];
    const real = { assert: (_a: any, m?: string) => seen.push(m ?? ""), log: () => {} } as unknown as TestContext;
    const q = quarantinedCtx(real);
    q.assert(false, "probe-noise");
    // no flush → discarded
    expect(seen).toHaveLength(0);
  });

  test("validate runs a parse-only schema and returns the transformed value", () => {
    const real = { validate: () => {}, log: () => {} } as unknown as TestContext;
    const q = quarantinedCtx(real);
    const parseSchema = { parse: (d: any) => ({ ...d, parsed: true }) } as any;
    const out = q.validate({ a: 1 }, parseSchema, "body");
    expect(out).toEqual({ a: 1, parsed: true }); // transformed, not undefined
    expect(q.hasFailure()).toBe(false);
  });

  test("validate records failure when a parse-only schema throws", () => {
    const real = { validate: () => {}, log: () => {} } as unknown as TestContext;
    const q = quarantinedCtx(real);
    const badSchema = { parse: () => { throw new Error("bad"); } } as any;
    const out = q.validate({ a: 1 }, badSchema, "body");
    expect(out).toBeUndefined();
    expect(q.hasFailure()).toBe(true);
  });

  test("fail buffers the assertion (no real emit until flush) and throws", () => {
    const seen: Array<{ passed: boolean; msg?: string }> = [];
    let realFailCalled = false;
    const real = {
      assert: (a: any, msg?: string) => seen.push({ passed: a.passed ?? a, msg }),
      fail: () => { realFailCalled = true; throw new Error("real-fail"); },
      log: () => {},
    } as unknown as TestContext;
    const q = quarantinedCtx(real);
    expect(() => q.fail("boom")).toThrow("boom");
    expect(realFailCalled).toBe(false); // did NOT delegate to real.fail (no orphan leak)
    expect(seen).toHaveLength(0); // buffered
    expect(q.hasFailure()).toBe(true);
    q.flushTo(real);
    expect(seen).toEqual([{ passed: false, msg: "boom" }]);
  });

  test("prototype-inherited ctx APIs survive quarantine (test.extend fixture ctx)", () => {
    const base = {
      vars: { get: () => "v" },
      log: () => {},
      assert: () => {},
    } as unknown as TestContext;
    const fixtureCtx = Object.create(base) as TestContext; // prototype-linked, like test.extend
    const q = quarantinedCtx(fixtureCtx);
    expect((q as any).vars.get()).toBe("v"); // inherited via prototype chain, not dropped
    expect(typeof (q as any).log).toBe("function");
  });

  test("validate with severity:fatal throws on failure (control flow preserved)", () => {
    const real = { validate: () => {}, log: () => {} } as unknown as TestContext;
    const q = quarantinedCtx(real);
    const schema = { safeParse: (_d: any) => ({ success: false }) } as any;
    expect(() => q.validate({ a: 1 }, schema, "body", { severity: "fatal" })).toThrow(/fatal validation/);
    expect(q.hasFailure()).toBe(true);
  });

  test("validate with severity:fatal throws for a schema with NO parser (can't prove success)", () => {
    const real = { validate: () => {}, log: () => {} } as unknown as TestContext;
    const q = quarantinedCtx(real);
    // GLU-90 shape: a hand-rolled SchemaLike carrying only a `jsonSchema`
    // companion — no safeParse, no parse. Nothing can validate the data, so a
    // fatal validation must abort rather than return an unproven `undefined`
    // (the fatal overload's narrowed `T` return type depends on it).
    const jsonSchemaOnly = { jsonSchema: { type: "object" } } as any;
    expect(() =>
      q.validate({ a: 1 }, jsonSchemaOnly, "body", { severity: "fatal" }),
    ).toThrow(/fatal validation/);
    expect(q.hasFailure()).toBe(true);
  });

  test("validate with a NO-parser schema counts as a failed validation at non-fatal severity", () => {
    const real = { validate: () => {}, log: () => {} } as unknown as TestContext;
    const q = quarantinedCtx(real);
    const jsonSchemaOnly = { jsonSchema: { type: "object" } } as any;
    // Return value is unchanged (`undefined`, matching `T | undefined`), but the
    // attempt must be recorded as failing — parity with the real ctx, which
    // routes "Schema has neither safeParse nor parse method" to assert(false).
    expect(q.validate({ a: 1 }, jsonSchemaOnly, "body")).toBeUndefined();
    expect(q.hasFailure()).toBe(true);
  });
});
