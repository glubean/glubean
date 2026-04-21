/**
 * R1 carrier tests. The default impl is globalThis-backed — these tests lock
 * in the legacy behavior so the later R2 ALS swap has an explicit regression
 * contract to satisfy.
 */

import { afterEach, describe, expect, test } from "vitest";
import {
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

describe("RuntimeCarrier — globalThis impl (R1 default)", () => {
  afterEach(() => {
    // Reinstall a fresh carrier + clear globalThis slot so one test's state
    // doesn't leak into the next.
    installCarrier(createGlobalThisCarrier());
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
