import { describe, expect, it } from "vitest";

import { AdmissionCancelledError, ContinuationBacklogFullError, ContinuationPool } from "./continuation-pool.js";

/** A clock the test advances by hand so back-pressure waits are deterministic. */
function manualClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 0;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe("ContinuationPool (M6)", () => {
  it("is unbounded when maxOutstanding is undefined — admit never blocks", async () => {
    const pool = new ContinuationPool(undefined, "block-producer", undefined, () => 0);
    for (let i = 0; i < 100; i++) expect(await pool.admit()).toBe(0);
    expect(pool.outstanding).toBe(100);
    expect(pool.atCapacity).toBe(false);
    expect(pool.peakOutstanding).toBe(100);
  });

  it("admits up to maxOutstanding without blocking and tracks the peak", async () => {
    const pool = new ContinuationPool(2, "block-producer", undefined, () => 0);
    expect(await pool.admit()).toBe(0);
    expect(await pool.admit()).toBe(0);
    expect(pool.outstanding).toBe(2);
    expect(pool.atCapacity).toBe(true);
    pool.release();
    expect(pool.outstanding).toBe(1);
    expect(pool.peakOutstanding).toBe(2);
  });

  it("block-producer: admit parks at capacity until a slot is released, measuring the wait", async () => {
    const clock = manualClock();
    const pool = new ContinuationPool(1, "block-producer", undefined, clock.now);
    expect(await pool.admit()).toBe(0); // fills the single slot

    let resolved = false;
    const blocked = pool.admit().then((ms) => { resolved = true; return ms; });
    await Promise.resolve(); // let admit park
    expect(resolved).toBe(false); // still blocked
    expect(pool.outstanding).toBe(1);

    clock.advance(40);
    pool.release(); // hands the slot to the parked producer (no decrement)
    const waitMs = await blocked;
    expect(resolved).toBe(true);
    expect(waitMs).toBe(40); // back-pressure duration
    expect(pool.outstanding).toBe(1); // capacity transferred, not freed
  });

  it("fail-iteration: admit throws when the backlog is full", async () => {
    const pool = new ContinuationPool(1, "fail-iteration", undefined, () => 0);
    expect(await pool.admit()).toBe(0);
    await expect(pool.admit()).rejects.toBeInstanceOf(ContinuationBacklogFullError);
    expect(pool.outstanding).toBe(1); // a rejected admit reserves nothing
  });

  it("closeImmediate() takes precedence over fail-iteration (deadline, not backlog-full)", async () => {
    const pool = new ContinuationPool(1, "fail-iteration", undefined, () => 0);
    await pool.admit(); // fill
    pool.closeImmediate(); // the run's wall-clock deadline closes the pool
    // Post-deadline, an at-capacity admit reports the run deadline (released-for-drain),
    // NOT a backlog-full failure — the run is already ending, so the policy is moot.
    await expect(pool.admit()).rejects.toMatchObject({
      name: "AdmissionCancelledError",
      reason: "runDeadlineReached",
    });
  });

  it("closeImmediate() rejects post-deadline admits even with free capacity", async () => {
    const pool = new ContinuationPool(undefined, "block-producer", undefined, () => 0); // unbounded
    pool.closeImmediate(); // run deadline before any continuation is admitted
    // Even with capacity to spare (unbounded), a post-deadline release is deadline-reached
    // — NOT a normal acquire — so releasedProducerSlots can't include post-deadline work.
    await expect(pool.admit()).rejects.toMatchObject({ reason: "runDeadlineReached" });
    expect(pool.outstanding).toBe(0); // nothing was acquired
  });

  it("hands released slots to parked producers in FIFO order", async () => {
    const pool = new ContinuationPool(1, "block-producer", undefined, () => 0);
    await pool.admit(); // slot taken
    const order: number[] = [];
    const a = pool.admit().then(() => order.push(1));
    const b = pool.admit().then(() => order.push(2));
    await Promise.resolve();
    pool.release(); // → a
    await a;
    pool.release(); // → b
    await b;
    expect(order).toEqual([1, 2]);
  });

  it("closeImmediate() cancels parked producers (runDeadlineReached) and rejects new parks", async () => {
    const pool = new ContinuationPool(1, "block-producer", undefined, () => 0);
    await pool.admit(); // fill the single slot
    let rejected: unknown;
    const parked = pool.admit().catch((e) => { rejected = e; }); // parks (backlog full)
    await Promise.resolve();
    pool.closeImmediate(); // wall-clock deadline: cancel parks at once

    await parked;
    expect(rejected).toBeInstanceOf(AdmissionCancelledError);
    expect((rejected as AdmissionCancelledError).reason).toBe("runDeadlineReached");
    // A fresh admit at capacity now rejects immediately (no new park), same reason.
    await expect(pool.admit()).rejects.toMatchObject({ reason: "runDeadlineReached" });
  });

  it("the always-on drainTimeout bounds a parked producer (drainTimeout) before the run ends", async () => {
    const clock = manualClock();
    const pool = new ContinuationPool(1, "block-producer", 15, clock.now); // 15ms per-park bound
    await pool.admit(); // fill
    let rejected: unknown;
    const parked = pool.admit().catch((e) => { rejected = e; });
    await Promise.resolve(); // let admit park (arms the 15ms drain timer)
    clock.advance(15);
    await new Promise((r) => setTimeout(r, 20)); // let the real drain timer fire
    await parked;
    expect(rejected).toBeInstanceOf(AdmissionCancelledError);
    expect((rejected as AdmissionCancelledError).waitMs).toBe(15);
    // Cancelled by its own drain bound mid-run — NOT a run deadline.
    expect((rejected as AdmissionCancelledError).reason).toBe("drainTimeout");
  });
});
