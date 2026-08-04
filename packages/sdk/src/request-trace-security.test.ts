import { describe, expect, test } from "vitest";
import {
  getRequestSensitiveValues,
  maskRequestSensitiveValues,
  REQUEST_SENSITIVE_VALUES,
} from "./request-trace-security.js";

describe("request trace sensitive-value masking", () => {
  test("normalizes non-wire context values", () => {
    expect(getRequestSensitiveValues({
      [REQUEST_SENSITIVE_VALUES]: ["abc", "abcdef", "abc", ""],
    })).toEqual(["abcdef", "abc"]);
    expect(getRequestSensitiveValues(undefined)).toEqual([]);
    expect(getRequestSensitiveValues({
      [REQUEST_SENSITIVE_VALUES]: "nope",
    })).toEqual([]);
  });

  test("masks longest overlapping and transport-encoded variants", () => {
    const values = getRequestSensitiveValues({
      [REQUEST_SENSITIVE_VALUES]: ["abc", "abcdef", "sk live/abc="],
    });
    const masked = maskRequestSensitiveValues(
      "abcdef sk%20live%2Fabc%3D sk+live%2Fabc%3D",
      values,
    );

    expect(masked).toBe("[REDACTED] [REDACTED] [REDACTED]");
  });

  test("masks exact fragments throughout nested trace data without mutating input", () => {
    const trace = {
      requestHeaders: { "x-tenant": "Bearer secret-token" },
      requestBody: {
        tenantRef: "prefix-secret-token-suffix",
        nested: ["secret-token", { keep: true }],
      },
      responseBody: { echoed: "secret-token" },
    };

    const masked = maskRequestSensitiveValues(trace, ["secret-token"]);

    expect(masked).toEqual({
      requestHeaders: { "x-tenant": "Bearer [REDACTED]" },
      requestBody: {
        tenantRef: "prefix-[REDACTED]-suffix",
        nested: ["[REDACTED]", { keep: true }],
      },
      responseBody: { echoed: "[REDACTED]" },
    });
    expect(trace.requestBody.tenantRef).toBe("prefix-secret-token-suffix");
  });
});
