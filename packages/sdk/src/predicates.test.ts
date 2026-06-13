import { describe, test, expect } from "vitest";
import {
  predicateScope,
  evalPredicate,
  assertSelectorSource,
  extractPredicate,
  type BranchPredicate,
  type OpaquePredicate,
} from "./predicates.js";
import { LensPurityError } from "./contract-core.js";

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
