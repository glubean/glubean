/**
 * Tests for gRPC custom matchers (registered via plugin manifest, not side-effect import).
 *
 * Scope:
 *   - toHaveGrpcStatus(code) — positive + negative + wrong-shape actual
 *   - toHaveGrpcOk() — convenience wrapper
 *   - toHaveGrpcMetadata(key[, value]) — presence + value + case-insensitive
 *   - Integration: matchers chain with `.not` and soft assertion semantics
 */

import { test, expect, beforeAll, describe } from "vitest";
import { installPlugin } from "@glubean/sdk";
import { Expectation } from "@glubean/sdk/expect";
import grpcPlugin from "../index.js";

// Install the gRPC manifest once per test file so the custom matchers land
// on Expectation.prototype before any `new Expectation(...)` is instantiated.
beforeAll(async () => {
  await installPlugin(grpcPlugin);
});

// ---------------------------------------------------------------------------
// Harness — minimal Expectation with in-memory assertion sink
// ---------------------------------------------------------------------------

function makeExpectation<T>(actual: T) {
  const emissions: Array<{ passed: boolean; message: string }> = [];
  const emitter = (result: { passed: boolean; message: string }) => {
    emissions.push(result);
  };
  const e = new Expectation<T>(actual, emitter);
  return { e, emissions };
}

// ---------------------------------------------------------------------------
// toHaveGrpcStatus
// ---------------------------------------------------------------------------

describe("toHaveGrpcStatus", () => {
  test("passes when status.code matches", () => {
    const { e, emissions } = makeExpectation({
      status: { code: 0, details: "OK" },
    });
    e.toHaveGrpcStatus(0);
    expect(emissions[0].passed).toBe(true);
  });

  test("fails when status.code does not match", () => {
    const { e, emissions } = makeExpectation({
      status: { code: 5, details: "user not found" },
    });
    e.toHaveGrpcStatus(0);
    expect(emissions[0].passed).toBe(false);
    expect(emissions[0].message).toMatch(/gRPC status 0/);
    // Details surfaced in the failure message for agent-friendly triage
    expect(emissions[0].message).toMatch(/user not found/);
  });

  test("fails gracefully when actual is not a gRPC response shape", () => {
    const { e, emissions } = makeExpectation({ nope: true });
    e.toHaveGrpcStatus(0);
    expect(emissions[0].passed).toBe(false);
    expect(emissions[0].message).toMatch(/no `\.status\.code`/);
  });

  test("fails when actual is null/undefined", () => {
    const { e: e1, emissions: em1 } = makeExpectation(null);
    e1.toHaveGrpcStatus(0);
    expect(em1[0].passed).toBe(false);

    const { e: e2, emissions: em2 } = makeExpectation(undefined);
    e2.toHaveGrpcStatus(0);
    expect(em2[0].passed).toBe(false);
  });

  test(".not inverts pass/fail", () => {
    const { e, emissions } = makeExpectation({
      status: { code: 5, details: "not found" },
    });
    e.not.toHaveGrpcStatus(0);
    expect(emissions[0].passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// toHaveGrpcOk
// ---------------------------------------------------------------------------

describe("toHaveGrpcOk", () => {
  test("passes when code === 0", () => {
    const { e, emissions } = makeExpectation({
      status: { code: 0, details: "OK" },
    });
    e.toHaveGrpcOk();
    expect(emissions[0].passed).toBe(true);
  });

  test("fails when code !== 0", () => {
    const { e, emissions } = makeExpectation({
      status: { code: 14, details: "unavailable" },
    });
    e.toHaveGrpcOk();
    expect(emissions[0].passed).toBe(false);
    expect(emissions[0].message).toMatch(/gRPC status OK/);
  });

  test("fails gracefully when actual has no status", () => {
    const { e, emissions } = makeExpectation({ message: {} });
    e.toHaveGrpcOk();
    expect(emissions[0].passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// toHaveGrpcMetadata
// ---------------------------------------------------------------------------

describe("toHaveGrpcMetadata", () => {
  test("passes when key present (no value check)", () => {
    const { e, emissions } = makeExpectation({
      responseMetadata: { "x-request-id": "abc" },
    });
    e.toHaveGrpcMetadata("x-request-id");
    expect(emissions[0].passed).toBe(true);
  });

  test("fails when key absent", () => {
    const { e, emissions } = makeExpectation({
      responseMetadata: { "x-other": "v" },
    });
    e.toHaveGrpcMetadata("x-request-id");
    expect(emissions[0].passed).toBe(false);
    expect(emissions[0].message).toMatch(/x-request-id/);
  });

  test("passes when key + value match", () => {
    const { e, emissions } = makeExpectation({
      responseMetadata: { "x-tenant": "acme" },
    });
    e.toHaveGrpcMetadata("x-tenant", "acme");
    expect(emissions[0].passed).toBe(true);
  });

  test("fails when key present but value mismatches", () => {
    const { e, emissions } = makeExpectation({
      responseMetadata: { "x-tenant": "acme" },
    });
    e.toHaveGrpcMetadata("x-tenant", "glubean");
    expect(emissions[0].passed).toBe(false);
  });

  test("is case-insensitive on key (gRPC metadata convention)", () => {
    const { e, emissions } = makeExpectation({
      responseMetadata: { "X-Request-Id": "abc" },
    });
    e.toHaveGrpcMetadata("x-request-id");
    expect(emissions[0].passed).toBe(true);
  });

  test("fails gracefully when actual has no responseMetadata", () => {
    const { e, emissions } = makeExpectation({ status: { code: 0 } });
    e.toHaveGrpcMetadata("x-any");
    expect(emissions[0].passed).toBe(false);
    expect(emissions[0].message).toMatch(/no `\.responseMetadata`/);
  });

  test(".not inverts presence check", () => {
    const { e, emissions } = makeExpectation({
      responseMetadata: {},
    });
    e.not.toHaveGrpcMetadata("x-missing");
    expect(emissions[0].passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration — realistic GrpcCallResult shape
// ---------------------------------------------------------------------------

describe("integration on GrpcCallResult-shaped actual", () => {
  test("chained assertions on a realistic gRPC response", () => {
    const res = {
      message: { userId: "u_123", name: "Alice" },
      status: { code: 0, details: "OK" },
      responseMetadata: { "x-request-id": "req-1", "x-tenant": "acme" },
      duration: 42,
    };
    const { e, emissions } = makeExpectation(res);
    e.toHaveGrpcOk();
    e.toHaveGrpcStatus(0);
    e.toHaveGrpcMetadata("x-request-id");
    e.toHaveGrpcMetadata("x-tenant", "acme");
    e.not.toHaveGrpcStatus(5);
    expect(emissions.every((em) => em.passed)).toBe(true);
  });
});
