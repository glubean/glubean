/**
 * Tests for GraphQL custom matchers registered via side-effect import.
 *
 * Scope:
 *   - toHaveHttpStatus(code) — positive + negative + wrong-shape actual
 *   - toHaveGraphqlData(subset) — partial match + null/non-object data
 *   - toHaveGraphqlNoErrors() — absent + empty array + present errors
 *   - toHaveGraphqlErrorCode(code) — case-insensitive match on any entry
 *   - toHaveGraphqlExtension(key[, value]) — presence + value
 *   - Integration: matchers chain with `.not` and work on GraphqlCaseResult shape
 */

import { test, expect, describe } from "vitest";

// Side-effect import registers matchers (same entry users will use).
import "./index.js";

import { Expectation } from "@glubean/sdk/expect";
import type { GraphQLResult } from "../index.js";

function makeExpectation<T>(actual: T) {
  const emissions: Array<{ passed: boolean; message: string }> = [];
  const emitter = (result: { passed: boolean; message: string }) => {
    emissions.push(result);
  };
  const e = new Expectation<T>(actual, emitter);
  return { e, emissions };
}

function envelope<T = unknown>(
  overrides: Partial<GraphQLResult<T>> = {},
): GraphQLResult<T> {
  return {
    data: (overrides.data ?? null) as T | null,
    errors: overrides.errors,
    extensions: overrides.extensions,
    httpStatus: overrides.httpStatus ?? 200,
    headers: overrides.headers ?? {},
    rawBody: overrides.rawBody ?? null,
  };
}

// ---------------------------------------------------------------------------
// toHaveHttpStatus
// ---------------------------------------------------------------------------

describe("toHaveHttpStatus", () => {
  test("passes when httpStatus matches", () => {
    const { e, emissions } = makeExpectation(envelope({ httpStatus: 200 }));
    e.toHaveHttpStatus(200);
    expect(emissions[0].passed).toBe(true);
  });

  test("fails on mismatch", () => {
    const { e, emissions } = makeExpectation(envelope({ httpStatus: 500 }));
    e.toHaveHttpStatus(200);
    expect(emissions[0].passed).toBe(false);
    expect(emissions[0].message).toMatch(/HTTP status 200/);
  });

  test("fails gracefully when actual has no httpStatus", () => {
    const { e, emissions } = makeExpectation({ status: 200 });
    e.toHaveHttpStatus(200);
    expect(emissions[0].passed).toBe(false);
    expect(emissions[0].message).toMatch(/no `\.httpStatus`/);
  });

  test(".not inverts", () => {
    const { e, emissions } = makeExpectation(envelope({ httpStatus: 500 }));
    e.not.toHaveHttpStatus(200);
    expect(emissions[0].passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// toHaveGraphqlData
// ---------------------------------------------------------------------------

describe("toHaveGraphqlData", () => {
  test("passes when data contains subset", () => {
    const { e, emissions } = makeExpectation(
      envelope({ data: { user: { name: "Alice", id: "u-1" } } }),
    );
    e.toHaveGraphqlData({ user: { name: "Alice" } });
    expect(emissions[0].passed).toBe(true);
  });

  test("fails when data misses key", () => {
    const { e, emissions } = makeExpectation(
      envelope({ data: { user: { id: "u-1" } } }),
    );
    e.toHaveGraphqlData({ user: { name: "Alice" } });
    expect(emissions[0].passed).toBe(false);
  });

  test("fails when data is null", () => {
    const { e, emissions } = makeExpectation(envelope({ data: null }));
    e.toHaveGraphqlData({ any: "thing" });
    expect(emissions[0].passed).toBe(false);
    expect(emissions[0].message).toMatch(/`\.data` is null/);
  });

  test("fails on non-envelope shape", () => {
    const { e, emissions } = makeExpectation("not an envelope");
    e.toHaveGraphqlData({ any: "thing" });
    expect(emissions[0].passed).toBe(false);
  });

  test("handles array values via JSON-stringify equality", () => {
    const { e, emissions } = makeExpectation(
      envelope({ data: { tags: ["a", "b"] } }),
    );
    e.toHaveGraphqlData({ tags: ["a", "b"] });
    expect(emissions[0].passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// toHaveGraphqlNoErrors
// ---------------------------------------------------------------------------

describe("toHaveGraphqlNoErrors", () => {
  test("passes when errors is absent", () => {
    const { e, emissions } = makeExpectation(envelope({ data: { hi: "ok" } }));
    e.toHaveGraphqlNoErrors();
    expect(emissions[0].passed).toBe(true);
  });

  test("passes when errors is empty array", () => {
    const { e, emissions } = makeExpectation(envelope({ errors: [] }));
    e.toHaveGraphqlNoErrors();
    expect(emissions[0].passed).toBe(true);
  });

  test("fails when errors has entries + surfaces first 3 messages", () => {
    const { e, emissions } = makeExpectation(
      envelope({
        errors: [
          { message: "first" },
          { message: "second" },
          { message: "third" },
          { message: "fourth" },
        ],
      }),
    );
    e.toHaveGraphqlNoErrors();
    expect(emissions[0].passed).toBe(false);
    expect(emissions[0].message).toMatch(/got 4/);
    expect(emissions[0].message).toMatch(/first; second; third/);
    expect(emissions[0].message).toMatch(/\+1 more/);
  });

  test(".not inverts — pass when errors present", () => {
    const { e, emissions } = makeExpectation(
      envelope({ errors: [{ message: "x" }] }),
    );
    e.not.toHaveGraphqlNoErrors();
    expect(emissions[0].passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// toHaveGraphqlErrorCode
// ---------------------------------------------------------------------------

describe("toHaveGraphqlErrorCode", () => {
  test("passes when any error matches (case-insensitive)", () => {
    const { e, emissions } = makeExpectation(
      envelope({
        errors: [
          { message: "nope", extensions: { code: "UNAUTHENTICATED" } },
        ],
      }),
    );
    e.toHaveGraphqlErrorCode("unauthenticated");
    expect(emissions[0].passed).toBe(true);
  });

  test("matches second entry when first differs", () => {
    const { e, emissions } = makeExpectation(
      envelope({
        errors: [
          { message: "a", extensions: { code: "OTHER" } },
          { message: "b", extensions: { code: "FORBIDDEN" } },
        ],
      }),
    );
    e.toHaveGraphqlErrorCode("FORBIDDEN");
    expect(emissions[0].passed).toBe(true);
  });

  test("fails when no error matches", () => {
    const { e, emissions } = makeExpectation(
      envelope({ errors: [{ message: "a", extensions: { code: "OTHER" } }] }),
    );
    e.toHaveGraphqlErrorCode("FORBIDDEN");
    expect(emissions[0].passed).toBe(false);
  });

  test("fails gracefully when errors absent", () => {
    const { e, emissions } = makeExpectation(envelope({ data: { ok: true } }));
    e.toHaveGraphqlErrorCode("ANY");
    expect(emissions[0].passed).toBe(false);
    expect(emissions[0].message).toMatch(/no errors on envelope/);
  });
});

// ---------------------------------------------------------------------------
// toHaveGraphqlExtension
// ---------------------------------------------------------------------------

describe("toHaveGraphqlExtension", () => {
  test("passes on key presence (no value)", () => {
    const { e, emissions } = makeExpectation(
      envelope({ extensions: { tracing: { version: 1 } } }),
    );
    e.toHaveGraphqlExtension("tracing");
    expect(emissions[0].passed).toBe(true);
  });

  test("passes on key + value match", () => {
    const { e, emissions } = makeExpectation(
      envelope({ extensions: { version: "v2" } }),
    );
    e.toHaveGraphqlExtension("version", "v2");
    expect(emissions[0].passed).toBe(true);
  });

  test("fails when key absent", () => {
    const { e, emissions } = makeExpectation(
      envelope({ extensions: { other: "x" } }),
    );
    e.toHaveGraphqlExtension("missing");
    expect(emissions[0].passed).toBe(false);
  });

  test("fails gracefully when extensions missing", () => {
    const { e, emissions } = makeExpectation(envelope({ data: { ok: true } }));
    e.toHaveGraphqlExtension("tracing");
    expect(emissions[0].passed).toBe(false);
    expect(emissions[0].message).toMatch(/no `\.extensions`/);
  });
});

// ---------------------------------------------------------------------------
// Integration — realistic GraphqlCaseResult shape
// ---------------------------------------------------------------------------

describe("integration on GraphqlCaseResult-shaped actual", () => {
  test("chained assertions on a realistic GraphQL response", () => {
    const res = {
      data: { user: { id: "u-1", name: "Alice" } },
      extensions: { tracing: { version: 1 } },
      httpStatus: 200,
      headers: { "x-request-id": "req-1" },
      rawBody: '{"data":{"user":{"id":"u-1","name":"Alice"}}}',
      operationName: "GetUser",
      duration: 42,
    };
    const { e, emissions } = makeExpectation(res);
    e.toHaveHttpStatus(200);
    e.toHaveGraphqlData({ user: { name: "Alice" } });
    e.toHaveGraphqlNoErrors();
    e.toHaveGraphqlExtension("tracing");
    e.not.toHaveGraphqlErrorCode("UNAUTHENTICATED");
    expect(emissions.every((em) => em.passed)).toBe(true);
  });

  test("negative case: auth 401 with UNAUTHENTICATED code", () => {
    const res = {
      data: null,
      errors: [
        { message: "no token", extensions: { code: "UNAUTHENTICATED" } },
      ],
      httpStatus: 401,
      headers: {},
      rawBody: '{"errors":[...]}',
      operationName: "Me",
      duration: 5,
    };
    const { e, emissions } = makeExpectation(res);
    e.toHaveHttpStatus(401);
    e.toHaveGraphqlErrorCode("UNAUTHENTICATED");
    e.not.toHaveGraphqlNoErrors();
    expect(emissions.every((em) => em.passed)).toBe(true);
  });
});
