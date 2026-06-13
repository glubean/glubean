import { describe, test, expect } from "vitest";
import {
  predicateScope,
  evalPredicate,
  assertSelectorSource,
  selectBranchSteps,
  extractPredicate,
  extractBranchStep,
  type BranchPredicate,
  type OpaquePredicate,
  type RuntimeBranchStep,
} from "./predicates.js";
import { LensPurityError, runFlow, normalizeFlow } from "./contract-core.js";
import type {
  RuntimeFlowStep,
  RuntimeFlowProjection,
  FlowContract,
} from "./contract-types.js";
import type { TestContext } from "./types.js";

interface S {
  email: string;
  status?: number;
  user?: { id: string; tier: string | null };
  flag: boolean;
}

const w = predicateScope<S>();

describe("predicate construction", () => {
  test("when().eq() captures path, is branded + frozen", () => {
    const p = w.when((s) => s.status).eq(404) as any;
    expect(p.kind).toBe("compare");
    expect(p.op).toBe("eq");
    expect(p.path).toEqual(["status"]);
    expect(p.value).toBe(404);
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.path)).toBe(true);
    expect(() => {
      (p as any).value = 200;
    }).toThrow(); // frozen (strict mode)
  });

  test("nested path extraction", () => {
    const p = w.when((s) => s.user?.id).eq("u1") as any;
    expect(p.path).toEqual(["user", "id"]);
  });

  test("matches preserves regex flags", () => {
    const p = w.when((s) => s.email).matches(/^a/i) as any;
    expect(p.kind).toBe("matches");
    expect(p.pattern).toBe("^a");
    expect(p.flags).toBe("i");
  });

  test("and/or/not compose", () => {
    const p = w.all(w.when((s) => s.flag).truthy(), w.when((s) => s.status).eq(200)) as any;
    expect(p.kind).toBe("and");
    expect(p.clauses).toHaveLength(2);
    expect(Object.isFrozen(p.clauses)).toBe(true);
  });
});

describe("P0 single-selector gate (rejects non-selectors)", () => {
  const bad: Array<[string, (s: S) => unknown]> = [
    ["ternary", (s) => (s.flag ? s.status : s.email)],
    ["method call", (s) => s.email.toUpperCase()],
    ["arithmetic", (s) => (s.status ?? 0) + 1],
    ["logical", (s) => s.flag && s.status],
    ["computed index", (s) => (s as any)["status"]],
    ["free variable / Date.now", () => Date.now()],
    ["literal", () => 404],
  ];
  for (const [name, fn] of bad) {
    test(`rejects ${name}`, () => {
      // The throw fires at `when()` (source gate), before `.eq` runs; cast the
      // clause to sidestep the `never` operand the `any` lens would otherwise infer.
      expect(() => (w.when(fn as any) as any).eq(1)).toThrow(LensPurityError);
    });
  }

  test("accepts plain + optional-chain selectors", () => {
    expect(() => assertSelectorSource((s: S) => s.email)).not.toThrow();
    expect(() => assertSelectorSource((s: S) => s.user?.id)).not.toThrow();
  });
});

describe("operand validation", () => {
  test("rejects non-finite numeric operands", () => {
    expect(() => w.when((s) => s.status).eq(NaN as any)).toThrow(LensPurityError);
    expect(() => w.when((s) => s.status).eq(Infinity as any)).toThrow(LensPurityError);
    expect(() => w.when((s) => s.status).in([NaN as any])).toThrow(LensPurityError);
    expect(() => w.when((s) => s.status).gt(Infinity as any)).toThrow(LensPurityError);
  });
  test("empty all()/any() rejected", () => {
    expect(() => w.all()).toThrow(LensPurityError);
    expect(() => w.any()).toThrow(LensPurityError);
  });
});

describe("evalPredicate", () => {
  const base: S = { email: "a@b.com", status: 404, user: { id: "u1", tier: null }, flag: true };

  test("compare ops", () => {
    expect(evalPredicate(w.when((s) => s.status).eq(404), base)).toBe(true);
    expect(evalPredicate(w.when((s) => s.status).eq(200), base)).toBe(false);
    expect(evalPredicate(w.when((s) => s.status).ne(200), base)).toBe(true);
    expect(evalPredicate(w.when((s) => s.status).gt(400), base)).toBe(true);
    expect(evalPredicate(w.when((s) => s.status).gte(404), base)).toBe(true);
    expect(evalPredicate(w.when((s) => s.status).lt(500), base)).toBe(true);
    expect(evalPredicate(w.when((s) => s.status).lte(404), base)).toBe(true);
  });

  test("in / matches", () => {
    expect(evalPredicate(w.when((s) => s.status).in([200, 404]), base)).toBe(true);
    expect(evalPredicate(w.when((s) => s.status).in([200, 201]), base)).toBe(false);
    expect(evalPredicate(w.when((s) => s.email).matches(/@b\.com$/), base)).toBe(true);
  });

  test("presence three-state: null counts as exists, missing is absent", () => {
    // tier is explicit null
    expect(evalPredicate(w.when((s) => s.user?.tier).exists(), base)).toBe(true);
    expect(evalPredicate(w.when((s) => s.user?.tier).absent(), base)).toBe(false);
    expect(evalPredicate(w.when((s) => s.user?.tier).eq(null), base)).toBe(true);
    // missing path
    const noUser: S = { email: "x", flag: false };
    expect(evalPredicate(w.when((s) => s.user?.id).absent(), noUser)).toBe(true);
    expect(evalPredicate(w.when((s) => s.user?.id).exists(), noUser)).toBe(false);
  });

  test("truthy / falsy", () => {
    expect(evalPredicate(w.when((s) => s.flag).truthy(), base)).toBe(true);
    expect(evalPredicate(w.when((s) => s.flag).falsy(), base)).toBe(false);
  });

  test("safe traversal: missing intermediate does not throw", () => {
    const noUser: S = { email: "x", flag: false };
    // s.user is undefined → s.user.id traversal returns undefined, no TypeError
    expect(() => evalPredicate(w.when((s) => s.user?.id).eq("u1"), noUser)).not.toThrow();
    expect(evalPredicate(w.when((s) => s.user?.id).eq("u1"), noUser)).toBe(false);
  });

  test("and / or / not", () => {
    const p: BranchPredicate<S> = w.all(
      w.when((s) => s.flag).truthy(),
      w.any(w.when((s) => s.status).eq(404), w.when((s) => s.status).eq(500)),
    );
    expect(evalPredicate(p, base)).toBe(true);
    expect(evalPredicate(w.not(w.when((s) => s.status).eq(404)), base)).toBe(false);
  });
});

// =============================================================================
// Phase 2 — runtime branch node: selectBranchSteps / extract* / runFlow / normalizeFlow
// =============================================================================

const ctx = { log: () => {} } as unknown as TestContext;

// Distinct sentinel sub-step lists so we can assert which case was selected by
// reference identity (selectBranchSteps returns the matched `c.steps` array).
const compute = (name: string): RuntimeFlowStep => ({ kind: "compute", name, fn: (s) => s });
const caseA: RuntimeFlowStep[] = [compute("A")];
const caseB: RuntimeFlowStep[] = [compute("B")];
const caseC: RuntimeFlowStep[] = [compute("C")];
const dft: RuntimeFlowStep[] = [compute("D")];

describe("selectBranchSteps — value mode", () => {
  test("path-based subject: first match via safe traversal", async () => {
    const step: RuntimeBranchStep = {
      kind: "branch",
      mode: "value",
      subject: { lens: () => undefined, path: ["user", "tier"] },
      cases: [
        { value: "gold", steps: caseA },
        { value: "silver", steps: caseB },
      ],
      default: dft,
    };
    const state = { user: { tier: "silver" } };
    expect(await selectBranchSteps(step, state, ctx)).toBe(caseB);
  });

  test("no match → default", async () => {
    const step: RuntimeBranchStep = {
      kind: "branch",
      mode: "value",
      subject: { lens: () => undefined, path: ["user", "tier"] },
      cases: [{ value: "gold", steps: caseA }],
      default: dft,
    };
    expect(await selectBranchSteps(step, { user: { tier: "bronze" } }, ctx)).toBe(dft);
  });

  test("missing intermediate does not throw (safe traversal) → default", async () => {
    const step: RuntimeBranchStep = {
      kind: "branch",
      mode: "value",
      subject: { lens: () => undefined, path: ["user", "tier"] },
      cases: [{ value: "gold", steps: caseA }],
      default: dft,
    };
    // state.user is absent — path traversal must yield undefined, not throw.
    const taken = await selectBranchSteps(step, {}, ctx);
    expect(taken).toBe(dft);
  });

  test("lens-based subject (no path): evaluated exactly once", async () => {
    let calls = 0;
    const step: RuntimeBranchStep = {
      kind: "branch",
      mode: "value",
      subject: {
        lens: (_c, s: any) => {
          calls++;
          return s.k;
        },
      },
      cases: [
        { value: 1, steps: caseA },
        { value: 2, steps: caseB },
        { value: 3, steps: caseC },
      ],
      default: dft,
    };
    expect(await selectBranchSteps(step, { k: 3 }, ctx)).toBe(caseC);
    expect(calls).toBe(1);
  });
});

describe("selectBranchSteps — predicate mode", () => {
  const w2 = predicateScope<{ status: number }>();

  test("L2 declarative: first match wins", async () => {
    const step: RuntimeBranchStep = {
      kind: "branch",
      mode: "predicate",
      cases: [
        { predicate: w2.when((s) => s.status).eq(200), steps: caseA },
        { predicate: w2.when((s) => s.status).gte(400), steps: caseB },
      ],
      default: dft,
    };
    expect(await selectBranchSteps(step, { status: 404 }, ctx)).toBe(caseB);
    expect(await selectBranchSteps(step, { status: 200 }, ctx)).toBe(caseA);
    expect(await selectBranchSteps(step, { status: 302 }, ctx)).toBe(dft);
  });

  test("L1 opaque sync predicate", async () => {
    const pred: OpaquePredicate = {
      kind: "opaque",
      sync: true,
      fn: (_c, s: any) => s.status === 418,
    };
    const step: RuntimeBranchStep = {
      kind: "branch",
      mode: "predicate",
      cases: [{ message: "teapot", predicate: pred, steps: caseA }],
      default: dft,
    };
    expect(await selectBranchSteps(step, { status: 418 }, ctx)).toBe(caseA);
    expect(await selectBranchSteps(step, { status: 200 }, ctx)).toBe(dft);
  });

  test("L0 opaque async predicate (awaited)", async () => {
    const pred: OpaquePredicate = {
      kind: "opaque",
      sync: false,
      fn: async (_c, s: any) => {
        await Promise.resolve();
        return s.status >= 500;
      },
    };
    const step: RuntimeBranchStep = {
      kind: "branch",
      mode: "predicate",
      cases: [{ predicate: pred, steps: caseA }],
      default: dft,
    };
    expect(await selectBranchSteps(step, { status: 503 }, ctx)).toBe(caseA);
    expect(await selectBranchSteps(step, { status: 200 }, ctx)).toBe(dft);
  });

  test("L1 predicate that returns a thenable throws (must be sync)", async () => {
    const pred: OpaquePredicate = {
      kind: "opaque",
      sync: true,
      fn: () => Promise.resolve(true) as unknown as boolean,
    };
    const step: RuntimeBranchStep = {
      kind: "branch",
      mode: "predicate",
      cases: [{ predicate: pred, steps: caseA }],
      default: dft,
    };
    await expect(selectBranchSteps(step, { status: 1 }, ctx)).rejects.toThrow(/synchronous/);
  });
});

describe("extractPredicate — JSON-safe projection", () => {
  const w3 = predicateScope<{ a: number; b: string; flag: boolean }>();

  test("compare / in / presence / matches", () => {
    expect(extractPredicate(w3.when((s) => s.a).eq(1))).toEqual({
      kind: "compare",
      op: "eq",
      path: ["a"],
      value: 1,
    });
    expect(extractPredicate(w3.when((s) => s.a).in([1, 2]))).toEqual({
      kind: "in",
      path: ["a"],
      values: [1, 2],
    });
    expect(extractPredicate(w3.when((s) => s.flag).truthy())).toEqual({
      kind: "presence",
      op: "truthy",
      path: ["flag"],
    });
    expect(extractPredicate(w3.when((s) => s.b).matches(/^x/i))).toEqual({
      kind: "matches",
      path: ["b"],
      pattern: "^x",
      flags: "i",
    });
  });

  test("and / or / not compose recursively", () => {
    const p = w3.all(w3.when((s) => s.flag).truthy(), w3.not(w3.when((s) => s.a).eq(0)));
    expect(extractPredicate(p)).toEqual({
      kind: "and",
      clauses: [
        { kind: "presence", op: "truthy", path: ["flag"] },
        { kind: "not", clause: { kind: "compare", op: "eq", path: ["a"], value: 0 } },
      ],
    });
  });

  test("opaque L1 / L0 carry strictness + async-IO marker", () => {
    const l1: OpaquePredicate = { kind: "opaque", sync: true, fn: () => true };
    const l0: OpaquePredicate = { kind: "opaque", sync: false, fn: async () => true };
    expect(extractPredicate(l1)).toEqual({ kind: "opaque", strictness: "L1", mayDoAsyncIO: false });
    expect(extractPredicate(l0)).toEqual({ kind: "opaque", strictness: "L0", mayDoAsyncIO: true });
  });
});

describe("extractBranchStep — recursion + mode shapes", () => {
  // The recurse callback mirrors normalizeFlow: it labels compute steps.
  const recurse = (steps: RuntimeFlowStep[]) =>
    steps.map((s) =>
      s.kind === "compute"
        ? ({ kind: "compute", name: s.name, reads: [], writes: [] } as const)
        : ({ kind: "contract-call", name: s.name } as any),
    );
  const w4 = predicateScope<{ status: number }>();

  test("value mode → subjectPath + cases + default", () => {
    const step: RuntimeBranchStep = {
      kind: "branch",
      mode: "value",
      name: "by-tier",
      subject: { lens: () => undefined, path: ["user", "tier"] },
      cases: [{ value: "gold", steps: caseA }],
      default: dft,
    };
    expect(extractBranchStep(step, recurse)).toEqual({
      kind: "branch",
      mode: "value",
      name: "by-tier",
      subjectPath: ["user", "tier"],
      cases: [{ value: "gold", steps: [{ kind: "compute", name: "A", reads: [], writes: [] }] }],
      default: [{ kind: "compute", name: "D", reads: [], writes: [] }],
    });
  });

  test("predicate mode → cases carry message + extracted predicate", () => {
    const step: RuntimeBranchStep = {
      kind: "branch",
      mode: "predicate",
      cases: [{ message: "server error", predicate: w4.when((s) => s.status).gte(500), steps: caseA }],
      default: dft,
    };
    const out = extractBranchStep(step, recurse) as any;
    expect(out.mode).toBe("predicate");
    expect(out.cases[0].message).toBe("server error");
    expect(out.cases[0].predicate).toEqual({ kind: "compare", op: "gte", path: ["status"], value: 500 });
    expect(out.cases[0].steps).toEqual([{ kind: "compute", name: "A", reads: [], writes: [] }]);
  });

  test("nested branch recurses through the recurse callback", () => {
    const w5 = predicateScope<{ inner: boolean }>();
    const inner: RuntimeBranchStep = {
      kind: "branch",
      mode: "predicate",
      cases: [{ predicate: w5.when((s) => s.inner).truthy(), steps: caseA }],
      default: dft,
    };
    // A recurse that itself normalizes nested branches (as normalizeFlow does).
    const recurseDeep = (steps: RuntimeFlowStep[]): any[] =>
      steps.map((s) =>
        s.kind === "branch"
          ? extractBranchStep(s, recurseDeep)
          : { kind: "compute", name: (s as any).name, reads: [], writes: [] },
      );
    const outer: RuntimeBranchStep = {
      kind: "branch",
      mode: "value",
      subject: { lens: () => undefined, path: ["k"] },
      cases: [{ value: 1, steps: [inner] }],
      default: [],
    };
    const out = extractBranchStep(outer, recurseDeep) as any;
    expect(out.cases[0].steps[0].kind).toBe("branch");
    expect(out.cases[0].steps[0].mode).toBe("predicate");
  });
});

// --- runFlow branch execution (end-to-end via real runFlow) ------------------

function makeFlow(
  steps: RuntimeFlowStep[],
  initial: any,
  capture: (final: any) => void,
): FlowContract<any> {
  const runtime: RuntimeFlowProjection<any> & { id: string } = {
    protocol: "flow",
    id: "phase2-flow",
    setup: async () => initial,
    teardown: async (_c, s) => capture(s),
    steps,
  };
  return { _flow: runtime } as unknown as FlowContract<any>;
}

describe("runFlow — branch execution", () => {
  test("value-mode branch: taken case mutates the shared committed cell", async () => {
    let final: any;
    const branch: RuntimeFlowStep = {
      kind: "branch",
      mode: "value",
      subject: { lens: (_c, s: any) => s.role },
      cases: [
        { value: "admin", steps: [{ kind: "compute", fn: (s) => ({ ...s, route: "admin-panel" }) }] },
        { value: "user", steps: [{ kind: "compute", fn: (s) => ({ ...s, route: "home" }) }] },
      ],
      default: [{ kind: "compute", fn: (s) => ({ ...s, route: "login" }) }],
    };
    await runFlow(makeFlow([branch], { role: "user" }, (f) => (final = f)), ctx);
    expect(final.route).toBe("home");
  });

  test("non-taken branch sub-steps never run", async () => {
    let final: any;
    let takenRan = 0;
    let otherRan = 0;
    const branch: RuntimeFlowStep = {
      kind: "branch",
      mode: "predicate",
      cases: [
        {
          predicate: predicateScope<{ n: number }>().when((s) => s.n).gte(10),
          steps: [{ kind: "compute", fn: (s) => ((takenRan++), { ...s, hit: "big" }) }],
        },
      ],
      default: [{ kind: "compute", fn: (s) => ((otherRan++), { ...s, hit: "small" }) }],
    };
    await runFlow(makeFlow([branch], { n: 3 }, (f) => (final = f)), ctx);
    expect(final.hit).toBe("small");
    expect(takenRan).toBe(0); // taken-case predicate was false → its steps skipped
    expect(otherRan).toBe(1);
  });

  test("nested branch: inner branch reads state written by an earlier step", async () => {
    let final: any;
    const inner: RuntimeFlowStep = {
      kind: "branch",
      mode: "value",
      subject: { lens: (_c, s: any) => s.tier },
      cases: [{ value: "gold", steps: [{ kind: "compute", fn: (s) => ({ ...s, perk: "lounge" }) }] }],
      default: [{ kind: "compute", fn: (s) => ({ ...s, perk: "none" }) }],
    };
    const outer: RuntimeFlowStep = {
      kind: "branch",
      mode: "predicate",
      cases: [
        {
          predicate: predicateScope<{ loggedIn: boolean }>().when((s) => s.loggedIn).truthy(),
          // first set tier, then a nested branch keys off it
          steps: [{ kind: "compute", fn: (s) => ({ ...s, tier: "gold" }) }, inner],
        },
      ],
      default: [],
    };
    await runFlow(makeFlow([outer], { loggedIn: true }, (f) => (final = f)), ctx);
    expect(final.tier).toBe("gold");
    expect(final.perk).toBe("lounge");
  });

  test("value-mode subject is evaluated exactly once during a run", async () => {
    let final: any;
    let lensCalls = 0;
    const branch: RuntimeFlowStep = {
      kind: "branch",
      mode: "value",
      subject: {
        lens: (_c, s: any) => {
          lensCalls++;
          return s.k;
        },
      },
      cases: [
        { value: 1, steps: [{ kind: "compute", fn: (s) => ({ ...s, m: "one" }) }] },
        { value: 2, steps: [{ kind: "compute", fn: (s) => ({ ...s, m: "two" }) }] },
      ],
      default: [{ kind: "compute", fn: (s) => ({ ...s, m: "dflt" }) }],
    };
    await runFlow(makeFlow([branch], { k: 2 }, (f) => (final = f)), ctx);
    expect(final.m).toBe("two");
    expect(lensCalls).toBe(1);
  });
});

describe("normalizeFlow — branch recursion", () => {
  test("branch with compute sub-steps normalizes recursively (value mode)", () => {
    const branch: RuntimeFlowStep = {
      kind: "branch",
      mode: "value",
      name: "route",
      subject: { lens: () => undefined, path: ["role"] },
      cases: [{ value: "admin", steps: [{ kind: "compute", name: "go-admin", fn: (s: any) => s }] }],
      default: [{ kind: "compute", name: "go-home", fn: (s: any) => s }],
    };
    const runtime: RuntimeFlowProjection<any> & { id: string } = {
      protocol: "flow",
      id: "norm-flow",
      steps: [branch],
    };
    const ext = normalizeFlow(runtime);
    expect(ext.steps).toHaveLength(1);
    const b = ext.steps[0] as any;
    expect(b.kind).toBe("branch");
    expect(b.mode).toBe("value");
    expect(b.subjectPath).toEqual(["role"]);
    expect(b.cases[0].value).toBe("admin");
    expect(b.cases[0].steps[0]).toMatchObject({ kind: "compute", name: "go-admin" });
    expect(b.default[0]).toMatchObject({ kind: "compute", name: "go-home" });
  });

  test("predicate-mode branch normalizes predicate + message", () => {
    const w6 = predicateScope<{ status: number }>();
    const branch: RuntimeFlowStep = {
      kind: "branch",
      mode: "predicate",
      cases: [
        {
          message: "error path",
          predicate: w6.when((s) => s.status).gte(400),
          steps: [{ kind: "compute", name: "handle-error", fn: (s: any) => s }],
        },
      ],
      default: [],
    };
    const runtime: RuntimeFlowProjection<any> & { id: string } = {
      protocol: "flow",
      id: "norm-pred",
      steps: [branch],
    };
    const b = normalizeFlow(runtime).steps[0] as any;
    expect(b.mode).toBe("predicate");
    expect(b.cases[0].message).toBe("error path");
    expect(b.cases[0].predicate).toEqual({ kind: "compare", op: "gte", path: ["status"], value: 400 });
    expect(b.cases[0].steps[0]).toMatchObject({ kind: "compute", name: "handle-error" });
  });
});
