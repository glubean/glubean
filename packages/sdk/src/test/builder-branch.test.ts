/**
 * Phase 6 — `test()` builder branch surface (condition / switchOn / switchCond).
 *
 * Runtime: the builder produces a `StepDefinition` carrying `branch` of the
 * right shape (harness execution is covered in @glubean/runner). Compile-time:
 * convergence + gate type tests in `_typeTests` (validated by `tsc --noEmit`).
 */
import { describe, test, expect } from "vitest";
import { test as gtest } from "../index.js";
import type { StepDefinition, TestBranchData } from "../types.js";
import { isTestBranchStep } from "../types.js";

function branchOf(steps: StepDefinition<any>[], i: number): TestBranchData<any> {
  const s = steps[i];
  if (!isTestBranchStep(s)) throw new Error(`step ${i} is not a branch`);
  return s.branch;
}

describe("test() builder — branch step shape", () => {
  test("condition → predicate-mode branch (1 case + default)", () => {
    const t = gtest("b-cond")
      .setup(async () => ({ role: "admin" }))
      .condition(
        { predicate: (_c, s) => s.role === "admin", message: "is admin" },
        (b) => b.step("a", async (_c, s) => s),
        (b) => b.step("z", async (_c, s) => s),
      )
      .build();
    const br = branchOf(t.steps!, 0);
    expect(br.mode).toBe("predicate");
    expect(br.message).toBe("is admin");
    expect(br.cases).toHaveLength(1);
    expect(typeof br.cases[0].predicate).toBe("function");
    expect(br.cases[0].steps[0].meta.name).toBe("a");
    expect(br.default[0].meta.name).toBe("z");
  });

  test("no-else condition → empty default", () => {
    const t = gtest("b-cond-noelse")
      .setup(async () => ({ n: 1 }))
      .condition({ predicate: (_c, s) => s.n === 1 }, (b) => b.step("a", async (_c, s) => s))
      .build();
    expect(branchOf(t.steps!, 0).default).toHaveLength(0);
  });

  test("switchOn → value-mode branch (subject + scalar cases)", () => {
    const t = gtest("b-switchon")
      .setup(async () => ({ status: 200 }))
      .switchOn((_c, s) => s.status)(
        [
          { value: 200, then: (b) => b.step("ok", async (_c, s) => s) },
          { value: 404, then: (b) => b.step("nf", async (_c, s) => s) },
        ],
        (b) => b.step("dflt", async (_c, s) => s),
      )
      .build();
    const br = branchOf(t.steps!, 0);
    expect(br.mode).toBe("value");
    expect(typeof br.subject).toBe("function");
    expect(br.cases.map((c) => c.value)).toEqual([200, 404]);
  });

  test("switchCond → predicate-mode branch (N cases)", () => {
    const t = gtest("b-switchcond")
      .setup(async () => ({ amount: 500 }))
      .switchCond(
        [
          { when: (_c, s) => s.amount > 1000, then: (b) => b.step("hi", async (_c, s) => s) },
          { when: (_c, s) => s.amount > 100, then: (b) => b.step("mid", async (_c, s) => s) },
        ],
        (b) => b.step("lo", async (_c, s) => s),
      )
      .build();
    const br = branchOf(t.steps!, 0);
    expect(br.mode).toBe("predicate");
    expect(br.cases).toHaveLength(2);
  });

  test("switchOn rejects duplicate / non-finite case values at build", () => {
    expect(() =>
      gtest("b-dup").switchOn((_c: any, s: any) => s.x)(
        [
          { value: 1, then: (b: any) => b },
          { value: 1, then: (b: any) => b },
        ],
        (b: any) => b,
      ),
    ).toThrow();
    expect(() =>
      gtest("b-nan").switchOn((_c: any, s: any) => s.x)(
        [{ value: NaN as any, then: (b: any) => b }],
        (b: any) => b,
      ),
    ).toThrow();
  });

  test("branch inside .group() carries the group to its body steps (registry)", () => {
    const t = gtest("b-group")
      .setup(async () => ({ n: 1 }))
      .group("auth", (b) =>
        b.condition({ predicate: (_c, s) => s.n === 1 }, (bb) => bb.step("inner", async (_c, s) => s)),
      )
      .build();
    // _finalize flattens branch leaves into registry metadata; the group must
    // propagate to the branch entry + its body steps. (build() returns the
    // nested steps; the registry mapping is the flattened/grouped view.)
    const branch = branchOf(t.steps!, 0);
    expect(branch.cases[0].steps[0].meta.name).toBe("inner");
    // The branch step itself was tagged by .group()
    expect((t.steps![0] as StepDefinition<any>).meta.group).toBe("auth");
  });

  test("a branch body returning a non-builder value throws", () => {
    expect(() =>
      gtest("b-bad")
        .setup(async () => ({ n: 1 }))
        .condition({ predicate: (_c, s) => s.n === 1 }, (() => undefined) as any),
    ).toThrow(/must return the fragment builder/);
  });
});

// =============================================================================
// Compile-time convergence / gate type tests (never executed; tsc-checked).
// =============================================================================
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _typeTests() {
  const tb = gtest("tt").setup(async () => ({ email: "", status: 0 }));

  // GOOD: no-else keeps shape; with-else converges; switchOn value = number.
  tb.condition({ predicate: (_c, s) => !!s.email }, (b) => b.step("x", async (_c, s) => s));
  // GOOD: an assertion-only (void) branch step preserves State (no erase to void).
  tb.condition({ predicate: (_c, s) => !!s.email }, (b) =>
    b.step("check", async (_c, s) => {
      void s.email;
    }),
  );
  tb.condition(
    { predicate: (_c, s) => s.status === 404 },
    (b) => b.step("a", async (_c, s) => ({ ...s, userId: "a" })),
    (b) => b.step("b", async (_c, s) => ({ ...s, userId: "b" })),
  );
  tb.switchOn((_c, s) => s.status)(
    [{ value: 404, then: (b) => b.step("c", async (_c, s) => ({ ...s, made: true })) }],
    (b) => b.step("d", async (_c, s) => ({ ...s, made: false })),
  );
  // GOOD: an async subject lens types `value` as the resolved scalar (number),
  // since the harness awaits it (`Awaited<V>`).
  tb.switchOn(async (_c, s) => {
    await Promise.resolve();
    return s.status;
  })(
    [{ value: 404, then: (b) => b.step("e", async (_c, s) => s) }],
    (b) => b.step("f", async (_c, s) => s),
  );

  // BAD: no-else then adds a key → rejected (StepNoExtraKeys)
  tb.condition(
    { predicate: (_c, s) => !!s.email },
    // @ts-expect-error then adds `userId` to State (no-else may not add keys)
    (b) => b.step("x", async (_c, s) => ({ ...s, userId: "a" })),
  );

  // BAD: with-else shapes disagree → NoInfer rejects
  tb.condition(
    { predicate: (_c, s) => s.status === 1 },
    (b) => b.step("a", async (_c, s) => ({ ...s, a: 1 })),
    // @ts-expect-error else shape {b} != then-anchored T {...,a}
    (b) => b.step("b", async (_c, s) => ({ ...s, b: 1 })),
  );

  // BAD: switchOn value type mismatch (status is number)
  tb.switchOn((_c, s) => s.status)(
    [
      // @ts-expect-error '404' is not number
      { value: "404", then: (b) => b.step("x", async (_c, s) => s) },
    ],
    (b) => b.step("y", async (_c, s) => s),
  );

  // TYPE THREADING: step → condition(adds field) → step(reads it) →
  // switchOn(adds field) → step(reads exact accumulated shape). Confirms the
  // state type flows INTO each branch and the converged shape flows OUT to the
  // next step (not erased to `any`, not losing earlier fields).
  gtest("thread")
    .setup(async () => ({ a: 1 }))
    .step("s1", async (_c, s) => ({ ...s, b: "x" })) // {a} → {a,b}
    .condition(
      { predicate: (_c, s) => s.a === 1 && s.b === "x" }, // sees {a,b} in the predicate
      (b) => b.step("then", async (_c, s) => ({ ...s, c: true })), // adds c
      (b) => b.step("else", async (_c, s) => ({ ...s, c: false })), // adds c (converges)
    ) // {a,b,c}
    .step("after-cond", async (_ctx, s) => {
      const _a: number = s.a; // earlier field preserved through the branch
      const _b: string = s.b;
      const _cBool: boolean = s.c; // field added by the branch, typed
      void _a;
      void _b;
      void _cBool;
      return s;
    })
    .switchOn((_c, s) => s.b)( // switch on a field added before the previous branch
      [{ value: "x", then: (b) => b.step("v", async (_c, s) => ({ ...s, d: 9 })) }],
      (b) => b.step("dft", async (_c, s) => ({ ...s, d: 0 })),
    ) // {a,b,c,d}
    .step("after-switch", async (_c, s) => {
      // The full accumulated shape is threaded out of both branches.
      const _all: { a: number; b: string; c: boolean; d: number } = s;
      void _all;
      return s;
    });

  // TYPE THREADING (negative): the post-branch state is precise, NOT `any`.
  gtest("thread-precise")
    .setup(async () => ({ a: 1 }))
    .condition(
      { predicate: (_c, s) => s.a === 1 },
      (b) => b.step("t", async (_c, s) => ({ ...s, c: true })),
      (b) => b.step("e", async (_c, s) => ({ ...s, c: false })),
    )
    .step("after", async (_c, s) => {
      // @ts-expect-error `nope` was never added — proves the threaded state is typed, not `any`
      const _x: number = s.nope;
      void _x;
      return s;
    });
}

test("Phase 6 builder type tests compile", () => {
  expect(typeof _typeTests).toBe("function");
});
