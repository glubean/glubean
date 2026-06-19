/**
 * Bounded continuation backlog for producer release (M6).
 *
 * When a load iteration calls `ctx.report.primaryComplete(..., { releaseProducerSlot:
 * true })`, its producer slot is freed to start a NEW primary iteration while the
 * rest of that iteration (the continuation — typically a poll-for-result loop) runs
 * in the background. This pool bounds how many continuations may be in flight at
 * once (`maxOutstanding`): when full, the producer is either back-pressured
 * (`block-producer` — `admit()` waits for a free slot, so the primary ingress rate
 * self-throttles to the continuation drain rate) or the iteration fails
 * (`fail-iteration` — `admit()` throws). An unset `maxOutstanding` is unbounded
 * (release frees the slot with no backlog cap).
 *
 * A parked `admit()` is bounded by `drainTimeoutMs` (from when it parks), if set, so
 * a backlog that never frees (a hung continuation) can't hang the run — even before
 * its bound is reached, when EVERY slot is parked and none can advance. The run's
 * wall-clock (duration) deadline additionally `closeImmediate()`s the pool, cancelling
 * parked producers at once.
 *
 * Single-process / single-threaded: all bookkeeping is synchronous between awaits,
 * so the counters never race. `maxConcurrent` is recorded in the config but
 * coincides with `maxOutstanding` here (every in-flight continuation is an actively
 * scheduled async flow), so this pool enforces the one bound.
 */

/** Thrown by `admit()` under `fail-iteration` when the backlog is full. */
export class ContinuationBacklogFullError extends Error {
  constructor() {
    super("continuation backlog is full");
    this.name = "ContinuationBacklogFullError";
  }
}

/** Why a parked `admit()` was cancelled: its own per-park drain bound expired
 *  mid-run (`drainTimeout` — the backlog never freed, a safety valve), or the run's
 *  wall-clock deadline closed the pool (`runDeadlineReached`). The two lead to
 *  different iteration outcomes, so the cause is carried, not flattened. */
export type AdmissionCancelReason = "drainTimeout" | "runDeadlineReached";

/** Thrown by a parked `admit()` when its drain bound expires or the run's wall-clock
 *  deadline closes the pool. Carries how long the producer was stalled and why. */
export class AdmissionCancelledError extends Error {
  constructor(readonly waitMs: number, readonly reason: AdmissionCancelReason) {
    super(`continuation admission cancelled (${reason})`);
    this.name = "AdmissionCancelledError";
  }
}

/** A producer parked on a full backlog (block-producer). `resolve(true)` grants it a
 *  slot; `resolve(false)` cancels its wait, with `reason` recording why (a per-park
 *  drain bound expired vs the run's wall-clock deadline closing the pool). */
interface Waiter {
  resolve: (granted: boolean) => void;
  timer?: ReturnType<typeof setTimeout>;
  reason?: AdmissionCancelReason;
}

export class ContinuationPool {
  private inFlight = 0;
  private peak = 0;
  private closed = false; // the run's wall-clock deadline — reject new parks at once
  private readonly waiters: Waiter[] = [];

  constructor(
    private readonly maxOutstanding: number | undefined,
    private readonly onBacklogFull: "block-producer" | "fail-iteration",
    private readonly drainTimeoutMs: number | undefined,
    private readonly now: () => number,
  ) {}

  /** Continuations currently in flight (admitted, not yet released). */
  get outstanding(): number {
    return this.inFlight;
  }

  /** Highest concurrent in-flight count reached (for the backlog report). */
  get peakOutstanding(): number {
    return this.peak;
  }

  /** Whether the backlog is at capacity right now (the next admit would block/fail). */
  get atCapacity(): boolean {
    return this.maxOutstanding !== undefined && this.inFlight >= this.maxOutstanding;
  }

  /**
   * Reserve a continuation slot. Returns the back-pressure wait in ms (0 if a slot
   * was immediately free). Throws `ContinuationBacklogFullError` under
   * `fail-iteration` when full, or `AdmissionCancelledError` when a parked wait is
   * cut short by its drain bound or the run's wall-clock deadline.
   */
  async admit(): Promise<number> {
    // The run's wall-clock deadline closes the pool and takes precedence over EVERYTHING
    // below — capacity AND backlog policy. Once it fires, every later release is
    // released-for-drain (runDeadlineReached): admitting a fresh continuation as a normal
    // `producer:released` (free capacity) would misaccount post-deadline work, and
    // failing it (fail-iteration) would spuriously fail a primary the run simply outran.
    // The tail still drains either way; this is purely correct deadline accounting.
    if (this.closed) {
      throw new AdmissionCancelledError(0, "runDeadlineReached"); // wall-clock up: never admit anew
    }
    if (!this.atCapacity) {
      this.acquire();
      return 0;
    }
    if (this.onBacklogFull === "fail-iteration") {
      throw new ContinuationBacklogFullError();
    }
    // block-producer: park until a releasing continuation hands its slot over, the
    // drain timeout expires, or the run's wall-clock deadline closes the pool.
    const start = this.now();
    const waiter: Waiter = { resolve: () => {} };
    const granted = await new Promise<boolean>((resolve) => {
      waiter.resolve = resolve;
      this.waiters.push(waiter);
      if (this.drainTimeoutMs !== undefined) {
        waiter.timer = setTimeout(() => this.cancel(waiter, "drainTimeout"), this.drainTimeoutMs);
      }
    });
    const waited = Math.max(0, this.now() - start);
    if (!granted) throw new AdmissionCancelledError(waited, waiter.reason ?? "runDeadlineReached");
    return waited;
  }

  /**
   * Free a continuation slot. If a producer is parked, hand the slot DIRECTLY to it
   * (in-flight count unchanged — capacity transfers) so no third producer can slip
   * in between; otherwise decrement.
   */
  release(): void {
    const next = this.waiters.shift();
    if (next) {
      if (next.timer !== undefined) clearTimeout(next.timer);
      next.resolve(true); // grant the slot
      return;
    }
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  /**
   * The run's wall-clock (duration) deadline: cancel every parked producer at once
   * and reject any later park immediately, so a slot blocked on a release can't
   * outrun the bound (its tail still drains, bounded by the run's drain phase).
   */
  closeImmediate(): void {
    this.closed = true;
    for (const w of [...this.waiters]) this.cancel(w, "runDeadlineReached");
  }

  /** Remove a parked producer and cancel its wait, recording WHY (its per-park drain
   *  bound expired, or the run's wall-clock deadline closed the pool) so `admit()`
   *  can throw the right cause. */
  private cancel(waiter: Waiter, reason: AdmissionCancelReason): void {
    const i = this.waiters.indexOf(waiter);
    if (i < 0) return; // already granted / cancelled
    this.waiters.splice(i, 1);
    if (waiter.timer !== undefined) clearTimeout(waiter.timer);
    waiter.reason = reason;
    waiter.resolve(false);
  }

  private acquire(): void {
    this.inFlight += 1;
    if (this.inFlight > this.peak) this.peak = this.inFlight;
  }
}
