/**
 * RuntimeCarrier tests.
 *
 * Two describe blocks, one per impl:
 * - ALS (default) — the production carrier. Locks in concurrent isolation.
 * - globalThis — retained as a revert target. Tested explicitly so the
 *   revert path doesn't silently bit-rot.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createAlsCarrier,
  createGlobalThisCarrier,
  getRuntime,
  installCarrier,
  runWithRuntime,
  setRuntime,
  type InternalRuntime,
} from "./runtime-carrier.js";

function makeFakeRuntime(marker: string): InternalRuntime {
  return {
    vars: { marker },
    secrets: {},
    session: {},
    http: {} as unknown as InternalRuntime["http"],
  };
}

describe("RuntimeCarrier — AsyncLocalStorage impl (default)", () => {
  beforeEach(() => {
    installCarrier(createAlsCarrier());
  });
  afterEach(() => {
    // Reinstall a fresh ALS carrier so module-slot state doesn't leak
    // into other test files.
    installCarrier(createAlsCarrier());
  });

  test("setRuntime + getRuntime round-trip (outside any runWith scope)", () => {
    const rt = makeFakeRuntime("a");
    setRuntime(rt);
    expect(getRuntime()).toBe(rt);
  });

  test("setRuntime(undefined) clears the module slot", () => {
    setRuntime(makeFakeRuntime("a"));
    setRuntime(undefined);
    expect(getRuntime()).toBeUndefined();
  });

  test("getRuntime() returns undefined when nothing is installed", () => {
    expect(getRuntime()).toBeUndefined();
  });

  test("does NOT write or read globalThis.__glubeanRuntime", () => {
    (globalThis as any).__glubeanRuntime = undefined;
    const rt = makeFakeRuntime("no-global");
    setRuntime(rt);
    // set() writes to the closure module slot, not the global.
    expect((globalThis as any).__glubeanRuntime).toBeUndefined();

    // Even if something external writes the global, the ALS carrier ignores it.
    (globalThis as any).__glubeanRuntime = makeFakeRuntime("ignored-external");
    expect(getRuntime()).toBe(rt);
    (globalThis as any).__glubeanRuntime = undefined;
  });

  test("runWith() sync: fn sees rt, previous restored after return", () => {
    const prior = makeFakeRuntime("prior");
    const scoped = makeFakeRuntime("scoped");
    setRuntime(prior);

    const observed = runWithRuntime(scoped, () => getRuntime());
    expect(observed).toBe(scoped);
    expect(getRuntime()).toBe(prior);
  });

  test("runWith() async: continuations across await still see scoped rt via ALS", async () => {
    const prior = makeFakeRuntime("prior");
    const scoped = makeFakeRuntime("scoped");
    setRuntime(prior);

    let before: InternalRuntime | undefined;
    let after: InternalRuntime | undefined;

    const result = await runWithRuntime(scoped, async () => {
      before = getRuntime();
      await new Promise((r) => setTimeout(r, 5));
      after = getRuntime();
      return "done";
    });

    expect(result).toBe("done");
    expect(before).toBe(scoped);
    expect(after).toBe(scoped);
    expect(getRuntime()).toBe(prior);
  });

  test("runWith() async reject: previous restored after settle", async () => {
    const prior = makeFakeRuntime("prior");
    setRuntime(prior);

    await expect(
      runWithRuntime(makeFakeRuntime("scoped"), async () => {
        await new Promise((r) => setTimeout(r, 5));
        throw new Error("boom-als");
      }),
    ).rejects.toThrow("boom-als");

    expect(getRuntime()).toBe(prior);
  });

  /**
   * The headline regression test. Under a single-slot impl (like the retained
   * globalThis carrier) two concurrent `runWith()` calls race the slot and
   * one would observe the other's runtime at unpredictable await points.
   * Under the default ALS impl, each continuation chain reads its own runtime
   * via `als.getStore()`.
   */
  test("concurrent runWith() calls are isolated", async () => {
    const rt1 = makeFakeRuntime("rt1");
    const rt2 = makeFakeRuntime("rt2");

    const observed1: (string | undefined)[] = [];
    const observed2: (string | undefined)[] = [];

    await Promise.all([
      runWithRuntime(rt1, async () => {
        observed1.push(getRuntime()?.vars.marker);
        await new Promise((r) => setTimeout(r, 15));
        observed1.push(getRuntime()?.vars.marker);
        await new Promise((r) => setTimeout(r, 5));
        observed1.push(getRuntime()?.vars.marker);
      }),
      runWithRuntime(rt2, async () => {
        observed2.push(getRuntime()?.vars.marker);
        await new Promise((r) => setTimeout(r, 5));
        observed2.push(getRuntime()?.vars.marker);
        await new Promise((r) => setTimeout(r, 15));
        observed2.push(getRuntime()?.vars.marker);
      }),
    ]);

    expect(observed1).toEqual(["rt1", "rt1", "rt1"]);
    expect(observed2).toEqual(["rt2", "rt2", "rt2"]);
  });

  test("nested runWith() inherits inner rt, restores outer on exit", async () => {
    const outer = makeFakeRuntime("outer");
    const inner = makeFakeRuntime("inner");

    const observed = await runWithRuntime(outer, async () => {
      const before = getRuntime()?.vars.marker;
      const innerObserved = await runWithRuntime(inner, async () => {
        return getRuntime()?.vars.marker;
      });
      const after = getRuntime()?.vars.marker;
      return { before, innerObserved, after };
    });

    expect(observed).toEqual({
      before: "outer",
      innerObserved: "inner",
      after: "outer",
    });
  });
});

describe("RuntimeCarrier — globalThis impl (retained revert target)", () => {
  beforeEach(() => {
    installCarrier(createGlobalThisCarrier());
    (globalThis as any).__glubeanRuntime = undefined;
  });
  afterEach(() => {
    // Restore the production ALS default + clear the globalThis slot so
    // globalThis-impl state doesn't leak into other test files.
    installCarrier(createAlsCarrier());
    (globalThis as any).__glubeanRuntime = undefined;
  });

  test("setRuntime() then getRuntime() round-trips", () => {
    const rt = makeFakeRuntime("a");
    setRuntime(rt);
    expect(getRuntime()).toBe(rt);
  });

  test("setRuntime(undefined) clears the slot", () => {
    setRuntime(makeFakeRuntime("a"));
    setRuntime(undefined);
    expect(getRuntime()).toBeUndefined();
  });

  test("setRuntime() writes directly to globalThis.__glubeanRuntime", () => {
    const rt = makeFakeRuntime("gs");
    setRuntime(rt);
    expect((globalThis as any).__glubeanRuntime).toBe(rt);
  });

  test("external writes to globalThis.__glubeanRuntime are visible to getRuntime()", () => {
    const rt = makeFakeRuntime("legacy");
    (globalThis as any).__glubeanRuntime = rt;
    expect(getRuntime()).toBe(rt);
  });

  test("runWithRuntime() sync: fn sees rt, previous restored", () => {
    const prior = makeFakeRuntime("prior");
    const scoped = makeFakeRuntime("scoped");
    setRuntime(prior);

    const observedInside = runWithRuntime(scoped, () => getRuntime());
    expect(observedInside).toBe(scoped);
    expect(getRuntime()).toBe(prior);
  });

  test("runWithRuntime() sync throw: previous restored", () => {
    const prior = makeFakeRuntime("prior");
    setRuntime(prior);

    expect(() =>
      runWithRuntime(makeFakeRuntime("scoped"), () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(getRuntime()).toBe(prior);
  });

  test("runWithRuntime() async: continuations after await see scoped rt, previous restored after settle", async () => {
    const prior = makeFakeRuntime("prior");
    const scoped = makeFakeRuntime("scoped");
    setRuntime(prior);

    const promise = runWithRuntime(scoped, async () => {
      await new Promise((r) => setTimeout(r, 5));
      return getRuntime();
    });

    // Restore must NOT have happened yet — fn is still awaiting.
    expect(getRuntime()).toBe(scoped);
    const observed = await promise;
    expect(observed).toBe(scoped);
    expect(getRuntime()).toBe(prior);
  });

  test("runWithRuntime() async reject: previous restored", async () => {
    const prior = makeFakeRuntime("prior");
    setRuntime(prior);

    await expect(
      runWithRuntime(makeFakeRuntime("scoped"), async () => {
        await new Promise((r) => setTimeout(r, 5));
        throw new Error("boom-async");
      }),
    ).rejects.toThrow("boom-async");

    expect(getRuntime()).toBe(prior);
  });
});

describe("RuntimeCarrier — installCarrier swap", () => {
  afterEach(() => {
    installCarrier(createAlsCarrier());
  });

  test("installCarrier() swaps the active impl", () => {
    let slot: InternalRuntime | undefined;
    installCarrier({
      get: () => slot,
      set: (rt) => {
        slot = rt;
      },
      runWith: (rt, fn) => {
        const prev = slot;
        slot = rt;
        try {
          return fn();
        } finally {
          slot = prev;
        }
      },
    });

    const rt = makeFakeRuntime("alt");
    setRuntime(rt);
    expect(getRuntime()).toBe(rt);
  });
});
