/**
 * Poll Phase 3 — `test()` builder poll surface (test().poll).
 *
 * Runtime: the builder produces a `StepDefinition` carrying `poll` (the harness
 * dispatches on it). Plus build-time bound validation and compile-time
 * `_typeTests` for the `Res` inference (never called; tsc enforces them).
 */
import { describe, test, expect } from "vitest";
import { test as gtest } from "../index.js";
import { isTestPollStep } from "../types.js";

describe("test() builder — poll step shape", () => {
  test("poll → a StepDefinition carrying poll (fn + until + bounds)", () => {
    const t = gtest("p-ok")
      .setup(async () => ({ n: 0 }))
      .poll("await", async () => ({ ready: true }), {
        until: (_c, res: any) => res.ready === true,
        timeout: 5000,
        every: 10,
        out: (s, res: any) => ({ ...s, ready: res.ready }),
      })
      .build();
    const step = t.steps![0];
    expect(isTestPollStep(step)).toBe(true);
    if (isTestPollStep(step)) {
      expect(step.meta.name).toBe("await");
      expect(typeof step.poll.fn).toBe("function");
      expect(typeof step.poll.until).toBe("function");
      expect(step.poll.timeout).toBe(5000);
      expect(step.poll.every).toBe(10);
    }
  });

  test("build-time: maxAttempts-only (no per-attempt budget) throws", () => {
    expect(() =>
      gtest("p-bad")
        .setup(async () => ({}))
        .poll("x", async () => ({}), { until: () => true, maxAttempts: 5 } as any),
    ).toThrow(/not bounded/);
  });

  test("build-time: no stop condition throws", () => {
    expect(() =>
      gtest("p-bad-2")
        .setup(async () => ({}))
        .poll("x", async () => ({}), { until: () => true } as any),
    ).toThrow(/stop condition/);
  });
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _typeTests() {
  // Res inferred from fn's return; until/out see it precisely.
  gtest("pt")
    .setup(async () => ({ jobId: "j" }))
    .poll(
      "await",
      async (): Promise<{ status: "pending" | "done"; attempts: number }> => ({ status: "done", attempts: 1 }),
      {
        until: (_c, res, s) => {
          const _st: "pending" | "done" = res.status; // Res inferred
          const _id: string = s.jobId; // state threaded
          void _st;
          void _id;
          return res.status === "done";
        },
        timeout: 5000,
        out: (s, res) => ({ ...s, attempts: res.attempts }), // res: the fn return
      },
    );

  // NEGATIVE: until reads a field not on the fn return → rejected (Res not `any`).
  gtest("pt-bad")
    .setup(async () => ({}))
    .poll("await", async (): Promise<{ status: string }> => ({ status: "done" }), {
      // @ts-expect-error `nope` is not on the fn return type
      until: (_c, res) => res.nope === 1,
      timeout: 5000,
    });
}
void _typeTests;
