/**
 * Phase 3 — FlowBuilder.condition / conditionFn / conditionAsync / switchOn /
 * switchCond authoring surface.
 *
 * Two kinds of checks live here:
 *   1. Runtime behavior + build-time validation (vitest describe/test blocks).
 *   2. Compile-time convergence / gate type tests inside `_typeTests` — never
 *      called, but type-checked by `tsc --noEmit` (mirrors Spike 0). The
 *      `@ts-expect-error` directives fail the typecheck if the error disappears.
 */
import { describe, test, expect } from "vitest";
import { contract, runFlow } from "./index.js";
import { LensPurityError } from "./contract-core.js";
import type { FlowBuilder } from "./contract-types.js";
import type { TestContext } from "./types.js";

const ctx = { log: () => {} } as unknown as TestContext;

/** Build + run a flow, returning its final committed state (captured via teardown). */
async function runCapture(build: (final: { value: any }) => any): Promise<any> {
  const box: { value: any } = { value: undefined };
  const f = build(box);
  await runFlow(f, ctx);
  return box.value;
}

describe("condition (L2) — desugar + execution", () => {
  test("predicate-mode branch with then + else; runs the matching branch", async () => {
    const box = { value: undefined as any };
    const f = contract
      .flow("p3-cond-1")
      .setup(async () => ({ status: 404 }))
      .condition(
        { predicate: (w) => w.when((s) => s.status).eq(404) },
        (b) => b.compute((s) => ({ ...s, route: "create" })),
        (b) => b.compute((s) => ({ ...s, route: "use" })),
      )
      .teardown(async (_c, s) => {
        box.value = s;
      })
      .build();

    const step = f._flow.steps[0] as any;
    expect(step.kind).toBe("branch");
    expect(step.mode).toBe("predicate");
    expect(step.cases).toHaveLength(1);
    expect(step.cases[0].predicate.kind).toBe("compare");
    expect(step.cases[0].steps).toHaveLength(1);
    expect(step.default).toHaveLength(1);

    await runFlow(f, ctx);
    expect(box.value.route).toBe("create");
  });

  test("no-else condition: else defaults to empty; false predicate is a no-op", async () => {
    // no-else `then` keeps State's shape but MAY narrow an existing key's value
    // (here flip `flagged: boolean` to `true`); the NoExtraKeys guard allows
    // value-narrowing while still rejecting added keys.
    const final = await runCapture((box) =>
      contract
        .flow("p3-cond-2")
        .setup(async () => ({ n: 1, flagged: false }))
        .condition({ predicate: (w) => w.when((s) => s.n).eq(999) }, (b) =>
          b.compute((s) => ({ ...s, flagged: true })),
        )
        .teardown(async (_c, s) => {
          box.value = s;
        })
        .build(),
    );
    // predicate false + no else → then never ran, `flagged` stays false
    expect(final).toEqual({ n: 1, flagged: false });
  });

  test("custom message is carried on the case", () => {
    const f = contract
      .flow("p3-cond-3")
      .setup(async () => ({ status: 200 }))
      .condition(
        { predicate: (w) => w.when((s) => s.status).eq(404), message: "not found" },
        (b) => b,
      )
      .build();
    const step = f._flow.steps[0] as any;
    expect(step.cases[0].message).toBe("not found");
  });
});

describe("conditionFn (L1) / conditionAsync (L0) — opaque tiers", () => {
  test("conditionFn builds a sync opaque predicate and runs it", async () => {
    const final = await runCapture((box) =>
      contract
        .flow("p3-condfn-1")
        .setup(async () => ({ role: "admin" }))
        .conditionFn(
          { predicate: (_c, s) => s.role === "admin", message: "is admin" },
          (b) => b.compute((s) => ({ ...s, panel: true })),
          (b) => b.compute((s) => ({ ...s, panel: false })),
        )
        .teardown(async (_c, s) => {
          box.value = s;
        })
        .build(),
    );
    expect(final.panel).toBe(true);
  });

  test("conditionAsync builds an async opaque predicate and awaits it", async () => {
    const final = await runCapture((box) =>
      contract
        .flow("p3-condasync-1")
        .setup(async () => ({ flag: false }))
        .conditionAsync(
          {
            predicate: async (_c, s) => {
              await Promise.resolve();
              return !s.flag;
            },
            message: "external check",
          },
          (b) => b.compute((s) => ({ ...s, branch: "then" })),
          (b) => b.compute((s) => ({ ...s, branch: "else" })),
        )
        .teardown(async (_c, s) => {
          box.value = s;
        })
        .build(),
    );
    expect(final.branch).toBe("then");
  });

  test("opaque predicate shape: { kind: opaque, sync }", () => {
    const f = contract
      .flow("p3-opaque-shape")
      .setup(async () => ({ x: 1 }))
      .conditionFn({ predicate: (_c, s) => s.x > 0, message: "m" }, (b) => b)
      .build();
    const pred = (f._flow.steps[0] as any).cases[0].predicate;
    expect(pred.kind).toBe("opaque");
    expect(pred.sync).toBe(true);
  });

  test("opaque predicate returning a non-boolean throws at run (fail-fast)", async () => {
    // L1: returns the truthy string "false" — must NOT silently take the branch
    const fL1 = contract
      .flow("p3-opaque-nonbool-l1")
      .setup(async () => ({ x: 1 }))
      .conditionFn({ predicate: (() => "false") as any, message: "bad" }, (b) => b)
      .build();
    await expect(runFlow(fL1, ctx)).rejects.toThrow(/must return a boolean/);

    // L0: returns an object
    const fL0 = contract
      .flow("p3-opaque-nonbool-l0")
      .setup(async () => ({ x: 1 }))
      .conditionAsync({ predicate: (async () => ({})) as any, message: "bad" }, (b) => b)
      .build();
    await expect(runFlow(fL0, ctx)).rejects.toThrow(/must return a boolean/);
  });

  test("opaque (L1/L0) without a message throws at build (runtime guard)", () => {
    expect(() =>
      contract
        .flow("p3-nomsg-1")
        .conditionFn({ predicate: (_c: any, _s: any) => true } as any, (b: any) => b),
    ).toThrow(LensPurityError);
    expect(() =>
      contract
        .flow("p3-nomsg-2")
        .conditionAsync({ predicate: async (_c: any, _s: any) => true } as any, (b: any) => b),
    ).toThrow(LensPurityError);
  });
});

describe("switchOn (value-switch) — desugar + execution + validation", () => {
  test("value-mode branch: subjectPath extracted, matching case runs", async () => {
    const box = { value: undefined as any };
    const f = contract
      .flow("p3-switchon-1")
      .setup(async () => ({ status: 200 }))
      .switchOn((s) => s.status)(
        [
          { value: 404, then: (b) => b.compute((s) => ({ ...s, r: "create" })) },
          { value: 200, then: (b) => b.compute((s) => ({ ...s, r: "use" })) },
        ],
        (b) => b.compute((s) => ({ ...s, r: "default" })),
      )
      .teardown(async (_c, s) => {
        box.value = s;
      })
      .build();

    const step = f._flow.steps[0] as any;
    expect(step.kind).toBe("branch");
    expect(step.mode).toBe("value");
    expect(step.subject.path).toEqual(["status"]);
    expect(step.cases.map((c: any) => c.value)).toEqual([404, 200]);

    await runFlow(f, ctx);
    expect(box.value.r).toBe("use");
  });

  test("no match → default case runs", async () => {
    const final = await runCapture((box) =>
      contract
        .flow("p3-switchon-2")
        .setup(async () => ({ status: 500 }))
        .switchOn((s) => s.status)(
          [{ value: 200, then: (b) => b.compute((s) => ({ ...s, r: "ok" })) }],
          (b) => b.compute((s) => ({ ...s, r: "fallback" })),
        )
        .teardown(async (_c, s) => {
          box.value = s;
        })
        .build(),
    );
    expect(final.r).toBe("fallback");
  });

  test("duplicate case value throws at build", () => {
    expect(() =>
      contract.flow("p3-switchon-dup").switchOn((s: any) => s.x)(
        [
          { value: 1, then: (b: any) => b },
          { value: 1, then: (b: any) => b },
        ],
        (b: any) => b,
      ),
    ).toThrow(LensPurityError);
  });

  test("non-finite case value throws at build", () => {
    expect(() =>
      contract.flow("p3-switchon-nan").switchOn((s: any) => s.x)(
        [{ value: NaN as any, then: (b: any) => b }],
        (b: any) => b,
      ),
    ).toThrow(LensPurityError);
  });

  test("non-scalar case values (undefined/bigint/symbol/object) throw at build", () => {
    const nonScalars: any[] = [undefined, 1n, Symbol("x"), { a: 1 }, [1, 2], () => 1];
    for (const v of nonScalars) {
      expect(() =>
        contract.flow("p3-switchon-nonscalar").switchOn((s: any) => s.x)(
          [{ value: v, then: (b: any) => b }],
          (b: any) => b,
        ),
      ).toThrow(LensPurityError);
    }
  });

  test("non-selector subject lens (ternary) throws at build", () => {
    expect(() =>
      contract.flow("p3-switchon-ternary").switchOn((s: any) => (s.flag ? s.a : s.b))(
        [{ value: 1, then: (b: any) => b }],
        (b: any) => b,
      ),
    ).toThrow(LensPurityError);
  });
});

describe("L2 predicate runtime brand (reject forged / non-JSON predicates)", () => {
  test("condition() with a forged opaque predicate throws (can't bypass message guard)", () => {
    expect(() =>
      contract.flow("p3-forge-1").condition(
        // forged opaque object — the brand is type-only, so only the runtime
        // tree validator catches this
        { predicate: () => ({ kind: "opaque", sync: true, fn: () => true }) as any },
        (b: any) => b,
      ),
    ).toThrow(LensPurityError);
  });

  test("switchCond() with a forged predicate throws", () => {
    expect(() =>
      contract.flow("p3-forge-2").switchCond(
        [{ when: () => ({ kind: "opaque", sync: false, fn: async () => true }) as any, then: (b: any) => b }],
        (b: any) => b,
      ),
    ).toThrow(LensPurityError);
  });

  test("condition() with a non-JSON operand (eq(undefined)) throws at construction", () => {
    expect(() =>
      contract
        .flow("p3-forge-3")
        .setup(async () => ({ x: 1 }))
        .condition({ predicate: (w) => w.when((s) => s.x).eq(undefined as any) }, (b) => b),
    ).toThrow(LensPurityError);
    expect(() =>
      contract
        .flow("p3-forge-4")
        .setup(async () => ({ x: 1 }))
        .condition({ predicate: (w) => w.when((s) => s.x).eq(1n as any) }, (b) => b),
    ).toThrow(LensPurityError);
  });

  test("condition() with a garbage predicate object throws", () => {
    expect(() =>
      contract.flow("p3-forge-5").condition({ predicate: () => ({ kind: "nope" }) as any }, (b: any) => b),
    ).toThrow(LensPurityError);
  });

  test("hand-authored but structurally-valid L2 node is rejected (no runtime brand)", () => {
    // This object looks like a valid compare node but never went through
    // predicateScope, so it bypassed the selector source/Proxy gate (its `path`
    // could be anything, e.g. a numeric index). The runtime brand catches it.
    expect(() =>
      contract.flow("p3-forge-8").condition(
        { predicate: () => ({ kind: "compare", op: "eq", path: ["items", "0"], value: "x" }) as any },
        (b: any) => b,
      ),
    ).toThrow(LensPurityError);
    // Same for a forged node nested inside a genuine all()/and node.
    expect(() =>
      contract
        .flow("p3-forge-9")
        .setup(async () => ({ a: 1 }))
        .condition(
          {
            predicate: (w) =>
              w.all(
                w.when((s) => s.a).eq(1),
                { kind: "presence", op: "truthy", path: ["forged"] } as any,
              ),
          },
          (b) => b,
        ),
    ).toThrow(LensPurityError);
  });

  test("relational op with a non-number operand (gt('0') / gt(null)) throws", () => {
    expect(() =>
      contract
        .flow("p3-forge-6")
        .setup(async () => ({ x: 1 }))
        .condition({ predicate: (w) => w.when((s) => s.x).gt("0" as any) }, (b) => b),
    ).toThrow(LensPurityError);
    expect(() =>
      contract
        .flow("p3-forge-7")
        .setup(async () => ({ x: 1 }))
        .condition({ predicate: (w) => w.when((s) => s.x).lte(null as any) }, (b) => b),
    ).toThrow(LensPurityError);
  });
});

describe("switchCond (cond-switch) — first-match predicate branch", () => {
  test("N-case predicate branch; first match wins", async () => {
    const box = { value: undefined as any };
    const f = contract
      .flow("p3-switchcond-1")
      .setup(async () => ({ amount: 500 }))
      .switchCond(
        [
          { when: (w) => w.when((s) => s.amount).gt(1000), then: (b) => b.compute((s) => ({ ...s, tier: "high" })) },
          { when: (w) => w.when((s) => s.amount).gt(100), then: (b) => b.compute((s) => ({ ...s, tier: "mid" })) },
        ],
        (b) => b.compute((s) => ({ ...s, tier: "low" })),
      )
      .teardown(async (_c, s) => {
        box.value = s;
      })
      .build();

    const step = f._flow.steps[0] as any;
    expect(step.kind).toBe("branch");
    expect(step.mode).toBe("predicate");
    expect(step.cases).toHaveLength(2);

    await runFlow(f, ctx);
    expect(box.value.tier).toBe("mid"); // 500 > 100 (first match), not > 1000
  });
});

describe("fragment is persistent — runtime follows the RETURNED builder", () => {
  test("a discarded intermediate mutation does not execute (block body returns earlier sink)", async () => {
    // Type-side: callback returns `b` (State unchanged). Runtime must match —
    // the discarded `compute` that reshaped state must NOT run.
    const final = await runCapture((box) =>
      contract
        .flow("p3-persist-1")
        .setup(async () => ({ ok: true as boolean }))
        .condition({ predicate: (w) => w.when((s) => s.ok).truthy() }, (b) => {
          // discarded: its result is not returned, so it must not take effect
          b.compute((s: any) => ({ reshaped: "oops" }));
          return b;
        })
        .teardown(async (_c, s) => {
          box.value = s;
        })
        .build(),
    );
    // branch ran (predicate true) but the discarded compute never executed
    expect(final).toEqual({ ok: true });
  });

  test("the returned chain IS what executes", async () => {
    const final = await runCapture((box) =>
      contract
        .flow("p3-persist-2")
        .setup(async () => ({ n: 0 }))
        .condition({ predicate: (w) => w.when((s) => s.n).eq(0) }, (b) =>
          b.compute((s) => ({ ...s, n: s.n + 1 })).compute((s) => ({ ...s, n: s.n + 10 })),
        )
        .teardown(async (_c, s) => {
          box.value = s;
        })
        .build(),
    );
    expect(final).toEqual({ n: 11 });
  });

  test("a branch body returning a non-builder value throws", () => {
    expect(() =>
      contract
        .flow("p3-persist-3")
        .setup(async () => ({ n: 0 }))
        .condition({ predicate: (w) => w.when((s) => s.n).eq(0) }, (() => undefined) as any),
    ).toThrow(/must return the fragment builder/);
  });
});

describe("nested branches via fragment builder", () => {
  test("condition nested inside a switchOn case reads earlier state", async () => {
    const final = await runCapture((box) =>
      contract
        .flow("p3-nested-1")
        .setup(async () => ({ status: 500, tier: "gold" }))
        .switchOn((s) => s.status)(
          [
            {
              value: 500,
              then: (b) =>
                b.condition(
                  { predicate: (w) => w.when((s) => s.tier).eq("gold") },
                  (b2) => b2.compute((s) => ({ ...s, perk: "lounge" })),
                  (b2) => b2.compute((s) => ({ ...s, perk: "none" })),
                ),
            },
          ],
          (b) => b.compute((s) => ({ ...s, perk: "n/a" })),
        )
        .teardown(async (_c, s) => {
          box.value = s;
        })
        .build(),
    );
    expect(final.perk).toBe("lounge");
  });
});

describe("projection (_extracted) for branches built via the builder", () => {
  test("condition → predicate-mode extracted branch with rendered predicate", () => {
    const f = contract
      .flow("p3-extract-1")
      .setup(async () => ({ status: 404 }))
      .condition(
        { predicate: (w) => w.when((s) => s.status).eq(404) },
        (b) => b.compute((s) => ({ ...s, made: true })),
        (b) => b.compute((s) => ({ ...s, made: false })),
      )
      .build();
    const ext = f._extracted.steps[0] as any;
    expect(ext.kind).toBe("branch");
    expect(ext.mode).toBe("predicate");
    expect(ext.cases[0].predicate).toEqual({ kind: "compare", op: "eq", path: ["status"], value: 404 });
  });

  test("conditionFn → opaque marker in projection", () => {
    const f = contract
      .flow("p3-extract-2")
      .setup(async () => ({ x: 1 }))
      .conditionFn({ predicate: (_c, s) => s.x > 0, message: "gate" }, (b) => b)
      .build();
    const ext = f._extracted.steps[0] as any;
    expect(ext.cases[0].predicate).toEqual({ kind: "opaque", strictness: "L1", mayDoAsyncIO: false });
    expect(ext.cases[0].message).toBe("gate");
  });

  test("switchOn → value-mode extracted branch with subjectPath + values", () => {
    const f = contract
      .flow("p3-extract-3")
      .setup(async () => ({ status: 200 }))
      .switchOn((s) => s.status)(
        [{ value: 200, then: (b) => b.compute((s) => ({ ...s, ok: true })) }],
        (b) => b.compute((s) => ({ ...s, ok: false })),
      )
      .build();
    const ext = f._extracted.steps[0] as any;
    expect(ext.mode).toBe("value");
    expect(ext.subjectPath).toEqual(["status"]);
    expect(ext.cases[0].value).toBe(200);
  });
});

// =============================================================================
// Compile-time convergence / gate type tests (never executed; tsc-checked).
// Mirrors Spike 0 (contract-flow-condition.spike0.ts).
// =============================================================================
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _typeTests() {
  const fb = contract.flow("tt").setup(async () => ({ email: "", status: 0 }));

  // GOOD 1: no-else, then keeps the State shape
  fb.condition({ predicate: (w) => w.when((s) => s.email).eq("x") }, (b) => b.compute((s) => s));

  // GOOD 2: predicate scope threads State; .eq locks the operand type
  fb.condition({ predicate: (w) => w.when((s) => s.status).eq(404) }, (b) => b);

  // GOOD 3: with else, both branches converge to one T
  const r3 = fb.condition(
    { predicate: (w) => w.when((s) => s.status).eq(404) },
    (b) => b.compute((s) => ({ ...s, userId: "a" })),
    (b) => b.compute((s) => ({ ...s, userId: "b" })),
  );
  r3 satisfies FlowBuilder<{ email: string; status: number; userId: string }>;

  // GOOD 4: curried switchOn — V infers from the lens; default anchors T
  const r4 = fb.switchOn((s) => s.status)(
    [
      { value: 404, then: (b) => b.compute((s) => ({ ...s, made: true })) },
      { value: 200, then: (b) => b.compute((s) => ({ ...s, made: true })) },
    ],
    (b) => b.compute((s) => ({ ...s, made: false })),
  );
  r4 satisfies FlowBuilder<{ email: string; status: number; made: boolean }>;

  // GOOD 5: switchCond ordered predicates converge
  const r5 = fb.switchCond(
    [{ when: (w) => w.when((s) => s.status).gt(400), then: (b) => b.compute((s) => ({ ...s, bad: true })) }],
    (b) => b.compute((s) => ({ ...s, bad: false })),
  );
  r5 satisfies FlowBuilder<{ email: string; status: number; bad: boolean }>;

  // GOOD 5b: no-else branch may NARROW an existing key's value (flip a flag) —
  // codex round-5 fix: this must NOT require manual widening.
  const fbFlag = contract.flow("tt-flag").setup(async () => ({ ok: false }));
  fbFlag.condition({ predicate: (w) => w.when((s) => s.ok).falsy() }, (b) =>
    b.compute((s) => ({ ...s, ok: true })),
  );

  // BAD 6: no-else, then ADDS a field → NoExtraKeys collapses the extra key to never
  fb.condition(
    { predicate: (w) => w.when((s) => s.email).eq("x") },
    // @ts-expect-error then returns FFB<{...,userId}>; extra key `userId` is rejected
    (b) => b.compute((s) => ({ ...s, userId: "a" })),
  );

  // BAD 6b: no-else, then REMOVES a key → `R extends State` fails (missing `status`)
  fb.condition(
    { predicate: (w) => w.when((s) => s.email).eq("x") },
    // @ts-expect-error then drops `status`, so R no longer extends State
    (b) => b.compute((s) => ({ email: s.email })),
  );

  // BAD 6c: no-else, then CHANGES an existing key's value type → `R extends State` fails
  fb.condition(
    { predicate: (w) => w.when((s) => s.email).eq("x") },
    // @ts-expect-error status retyped to string is not assignable to number
    (b) => b.compute((s) => ({ ...s, status: "oops" })),
  );

  // BAD 7: with else, branch shapes disagree → NoInfer rejects (no union fallback)
  fb.condition(
    { predicate: (w) => w.when((s) => s.status).eq(404) },
    (b) => b.compute((s) => ({ ...s, a: 1 })),
    // @ts-expect-error else shape {b} != then-anchored T {...,a}
    (b) => b.compute((s) => ({ ...s, b: 1 })),
  );

  // BAD 8: switchOn value type mismatches the lens (status is number, value is string)
  fb.switchOn((s) => s.status)(
    [
      // @ts-expect-error '404' is not number (V inferred from lens)
      { value: "404", then: (b) => b },
    ],
    (b) => b,
  );

  // BAD 9: async lens rejected by the when() signature
  fb.condition(
    // @ts-expect-error async lens returns a Promise → when expected type collapses to never
    { predicate: (w) => w.when(async (s) => s.status).eq(404) },
    (b) => b,
  );

  // BAD 10: lens reads a non-existent field (proves s is State, not any)
  fb.condition(
    // @ts-expect-error s.nope is not on State
    { predicate: (w) => w.when((s) => s.nope).eq(1) },
    (b) => b,
  );

  // BAD 11: .eq operand mismatches the lens value type
  fb.condition(
    // @ts-expect-error eq("x") vs number
    { predicate: (w) => w.when((s) => s.status).eq("x") },
    (b) => b,
  );

  // BAD 12: conditionFn requires a message (type-level)
  fb.conditionFn(
    // @ts-expect-error L1 spec requires `message`
    { predicate: (_c, s) => s.status === 1 },
    (b) => b,
  );
}

test("Phase 3 type tests compile", () => {
  // Presence of this test makes vitest load the file; the real assertions are
  // the @ts-expect-error / satisfies checks above, validated by `tsc --noEmit`.
  expect(typeof _typeTests).toBe("function");
});
