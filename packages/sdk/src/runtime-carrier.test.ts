/**
 * R1 carrier tests. The default impl is globalThis-backed — these tests lock
 * in the legacy behavior so the later R2 ALS swap has an explicit regression
 * contract to satisfy.
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

describe("RuntimeCarrier — globalThis impl (R1, retained as revert target)", () => {
  beforeEach(() => {
    // Explicitly install the R1 globalThis carrier so these tests exercise
    // that impl's contract — not the production R2 default.
    installCarrier(createGlobalThisCarrier());
    (globalThis as any).__glubeanRuntime = undefined;
  });
  afterEach(() => {
    // Restore the production R2 ALS default + clear the globalThis slot
    // so an R1 test's state doesn't leak into other test files.
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

  test("getRuntime() returns undefined when no runtime has been installed", () => {
    expect(getRuntime()).toBeUndefined();
  });

  test("R1 shim contract: setRuntime() is visible on globalThis.__glubeanRuntime", () => {
    const rt = makeFakeRuntime("shim");
    setRuntime(rt);
    expect((globalThis as any).__glubeanRuntime).toBe(rt);
  });

  test("R1 shim contract: external writes to globalThis.__glubeanRuntime are visible to getRuntime()", () => {
    // This is the shim path — a legacy plugin that still writes the global
    // slot directly must keep working in R1.
    const rt = makeFakeRuntime("legacy");
    (globalThis as any).__glubeanRuntime = rt;
    expect(getRuntime()).toBe(rt);
  });

  test("runWithRuntime() exposes rt inside fn and restores previous on exit", () => {
    const prior = makeFakeRuntime("prior");
    const scoped = makeFakeRuntime("scoped");
    setRuntime(prior);

    const observedInside = runWithRuntime(scoped, () => getRuntime());
    expect(observedInside).toBe(scoped);

    // Previous runtime restored after fn returns.
    expect(getRuntime()).toBe(prior);
  });

  test("runWithRuntime() restores previous even when fn throws", () => {
    const prior = makeFakeRuntime("prior");
    setRuntime(prior);

    expect(() =>
      runWithRuntime(makeFakeRuntime("scoped"), () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(getRuntime()).toBe(prior);
  });

  test("runWithRuntime() async: continuations after await still see scoped rt, previous restored after promise settles", async () => {
    const prior = makeFakeRuntime("prior");
    const scoped = makeFakeRuntime("scoped");
    setRuntime(prior);

    let observedBeforeAwait: InternalRuntime | undefined;
    let observedAfterAwait: InternalRuntime | undefined;

    const promise = runWithRuntime(scoped, async () => {
      observedBeforeAwait = getRuntime();
      await new Promise((r) => setTimeout(r, 5));
      observedAfterAwait = getRuntime();
      return "done";
    });

    expect(observedBeforeAwait).toBe(scoped);
    // Critical: restore must NOT have happened yet, because fn is still awaiting.
    expect(getRuntime()).toBe(scoped);

    const result = await promise;
    expect(result).toBe("done");
    expect(observedAfterAwait).toBe(scoped);
    // Now that fn settled, the previous runtime is restored.
    expect(getRuntime()).toBe(prior);
  });

  test("runWithRuntime() async: previous restored after fn rejects", async () => {
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

  test("installCarrier() swaps the impl — future R2 entry point", () => {
    // Simulate a minimal alternative impl to prove the interface swap works.
    // When R2 lands, this is where createAlsCarrier() plugs in.
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
    // The custom impl does not touch globalThis — confirm that.
    expect((globalThis as any).__glubeanRuntime).toBeUndefined();
  });
});

describe("RuntimeCarrier — AsyncLocalStorage impl (R2 default)", () => {
  beforeEach(() => {
    installCarrier(createAlsCarrier());
    (globalThis as any).__glubeanRuntime = undefined;
  });
  afterEach(() => {
    installCarrier(createAlsCarrier());
    (globalThis as any).__glubeanRuntime = undefined;
  });

  test("setRuntime + getRuntime round-trip (outside any runWith scope)", () => {
    const rt = makeFakeRuntime("a");
    setRuntime(rt);
    expect(getRuntime()).toBe(rt);
  });

  test("setRuntime writes to globalThis shim so external plugins observe it", () => {
    const rt = makeFakeRuntime("shim-r2");
    setRuntime(rt);
    expect((globalThis as any).__glubeanRuntime).toBe(rt);
  });

  test("external globalThis write is visible via getRuntime() as shim fallback", () => {
    const rt = makeFakeRuntime("legacy-external");
    (globalThis as any).__glubeanRuntime = rt;
    expect(getRuntime()).toBe(rt);
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
        throw new Error("boom-r2");
      }),
    ).rejects.toThrow("boom-r2");

    expect(getRuntime()).toBe(prior);
  });

  /**
   * The headline R2 regression test — this is the whole point of the ALS
   * impl. Under R1 globalThis, two concurrent `runWith()` calls race the
   * single slot and one would observe the other's runtime at unpredictable
   * await points. Under R2 ALS, each continuation chain reads its own
   * runtime via `als.getStore()`.
   */
  test("concurrent runWith() calls are isolated (the R2 promise)", async () => {
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
