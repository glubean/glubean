/**
 * Per-window producer-slot busy-time accumulator — the pressure-conformance
 * NUMERATOR (internal load-distributed-execution proposal §6.2).
 *
 * Windowed conformance is `conf_w = busySlotSeconds_w / targetSlotSeconds_w`; the
 * existing timeline's starts/ends/in-flight samples cannot derive slot OCCUPANCY once
 * producer release exists (a continuation is in flight but its slot is already free),
 * so this is dedicated reducer state. The reducer integrates each producer slot's
 * occupancy span — `producerSlot:start` .. `producerSlot:end`, both as offsets on the
 * shared run axis — into fixed-width windows that mirror the timeline's grid exactly
 * (same base width / coarsening-by-doubling / window cap), so the coordinator can put
 * the numerator against per-window targets on the same axis.
 *
 * MEASUREMENT CONTRACT (§6.2): think time counts as occupancy (the slot is occupied by
 * design — including a producer parked on a full continuation backlog), and pre-ramp
 * time never counts (the orchestrator emits `producerSlot:start` only after the slot's
 * ramp delay). Under the closed producer-slot model the [start, end) span IS the exact
 * occupancy integral, not an approximation. D0 only PRODUCES this numerator; the
 * conformance verdict (and the target-slot-seconds denominator) is the D1 coordinator's.
 *
 * Values are float busy-MILLISECONDS per window (spans are real time, not counts), so
 * unlike the timeline's event counters there is no safe-integer domain to guard: a
 * window's busy-ms is physically bounded by windowMs × live slot count.
 */

/** Versioned wire form of a {@link SlotBusyWindows} (embedded in `LoadReducerPartialV1`). */
export interface SlotBusyWindowsJSON {
  /** Payload schema version; `fromJSON` rejects anything it does not recognize. */
  v: 1;
  baseWindowMs: number;
  /** Current window width — always baseWindowMs · 2ⁿ (n = coarsening rounds so far). */
  windowMs: number;
  maxWindows: number;
  /** Sparse `[windowIndex, busyMs]` pairs, strictly ascending, index < maxWindows —
   *  canonical form, so equal accumulators produce byte-identical payloads. */
  windows: [number, number][];
}

export class SlotBusyWindows {
  private windowMs: number;
  // Sparse: only windows with recorded occupancy exist (an idle window is 0 by absence).
  private windows = new Map<number, number>();

  /** @param baseWindowMs initial window width (ms) — MUST match the timeline grid.
   *  @param maxWindows coarsening cap — MUST match the timeline's. */
  constructor(
    private readonly baseWindowMs = 250,
    private readonly maxWindows = 600,
  ) {
    this.windowMs = baseWindowMs;
  }

  /** Double the window width and fold each adjacent pair (2k, 2k+1 → k); busy-ms sums. */
  private coarsen(): void {
    const next = new Map<number, number>();
    for (const [i, busy] of this.windows) {
      const ni = Math.floor(i / 2);
      next.set(ni, (next.get(ni) ?? 0) + busy);
    }
    this.windows = next;
    this.windowMs *= 2;
  }

  /** Integrate one occupancy span `[startMs, endMs)` (ms offsets on the run axis) into
   *  the covered windows, coarsening first so the last covered index fits the cap.
   *  Negative offsets clamp to 0; an empty/inverted span is a no-op. */
  addSpan(startMs: number, endMs: number): void {
    const s = Math.max(0, startMs);
    const e = Math.max(0, endMs);
    if (!(Number.isFinite(s) && Number.isFinite(e)) || e <= s) return;
    // A span ending exactly on a boundary (e = k·windowMs) covers windows up to k-1
    // (same convention as the timeline's runEndIndex).
    while (Math.ceil(e / this.windowMs) - 1 >= this.maxWindows) this.coarsen();
    const first = Math.floor(s / this.windowMs);
    const last = Math.ceil(e / this.windowMs) - 1;
    for (let i = first; i <= last; i++) {
      const lo = Math.max(s, i * this.windowMs);
      const hi = Math.min(e, (i + 1) * this.windowMs);
      if (hi > lo) this.windows.set(i, (this.windows.get(i) ?? 0) + (hi - lo));
    }
  }

  /**
   * Fold another accumulator (same `baseWindowMs`) into this one — the cross-worker
   * combine. Width alignment mirrors {@link addSpan}/the timeline: the finer side is
   * folded to the coarser, widened further until the union's last window fits this
   * accumulator's cap. Per window busy-ms simply SUM (occupancy integrals are additive
   * across slots and across workers). `other` is never mutated. Same-origin is the
   * caller's contract, exactly as for the timeline merge.
   */
  merge(other: SlotBusyWindows): void {
    if (other === this) {
      throw new Error("SlotBusyWindows.merge: cannot merge an accumulator into itself");
    }
    if (other.baseWindowMs !== this.baseWindowMs) {
      throw new Error(
        `SlotBusyWindows.merge: baseWindowMs mismatch (${this.baseWindowMs} vs ${other.baseWindowMs}) — merged accumulators must share one window grid`,
      );
    }
    let targetMs = Math.max(this.windowMs, other.windowMs);
    const lastIdxAt = (t: SlotBusyWindows, widthMs: number): number => {
      let last = -1;
      const ratio = widthMs / t.windowMs;
      for (const i of t.windows.keys()) {
        const folded = Math.floor(i / ratio);
        if (folded > last) last = folded;
      }
      return last;
    };
    while (Math.max(lastIdxAt(this, targetMs), lastIdxAt(other, targetMs)) >= this.maxWindows) {
      targetMs *= 2;
    }
    while (this.windowMs < targetMs) this.coarsen();
    const ratio = this.windowMs / other.windowMs; // an exact power of 2 ≥ 1 (both baseWindowMs·2ⁿ)
    for (const [i, busy] of other.windows) {
      const t = Math.floor(i / ratio);
      this.windows.set(t, (this.windows.get(t) ?? 0) + busy);
    }
  }

  /** Deep copy (used by the reducer's export path to fold OPEN slot spans into a
   *  snapshot without mutating the live accumulator). */
  clone(): SlotBusyWindows {
    const c = new SlotBusyWindows(this.baseWindowMs, this.maxWindows);
    c.windowMs = this.windowMs;
    c.windows = new Map(this.windows);
    return c;
  }

  /** Serialize to the versioned wire form; also the `JSON.stringify` hook. */
  toJSON(): SlotBusyWindowsJSON {
    return {
      v: 1,
      baseWindowMs: this.baseWindowMs,
      windowMs: this.windowMs,
      maxWindows: this.maxWindows,
      windows: [...this.windows.entries()].sort((a, b) => a[0] - b[0]),
    };
  }

  /**
   * Revive an accumulator from its wire form. Throws (with the offending field) on any
   * malformed or unknown-version payload — never coerces silently. Validation follows
   * the partial-protocol trust model (see `partial.ts`): structure, types, per-field
   * domains, canonical ordering, and the operational width invariant — no cross-field
   * feasibility inference.
   */
  static fromJSON(json: unknown): SlotBusyWindows {
    if (typeof json !== "object" || json === null || Array.isArray(json)) {
      const got = json === null ? "null" : Array.isArray(json) ? "an array" : typeof json;
      throw new Error(`SlotBusyWindows.fromJSON: payload must be an object, got ${got}`);
    }
    const p = json as Record<string, unknown>;
    if (p.v !== 1) {
      throw new Error(
        `SlotBusyWindows.fromJSON: unsupported payload version ${JSON.stringify(p.v)} (expected 1)`,
      );
    }
    const baseWindowMs = p.baseWindowMs;
    if (typeof baseWindowMs !== "number" || !Number.isFinite(baseWindowMs) || baseWindowMs <= 0) {
      throw new Error(
        `SlotBusyWindows.fromJSON: baseWindowMs must be a positive finite number, got ${JSON.stringify(baseWindowMs)}`,
      );
    }
    const windowMs = p.windowMs;
    if (typeof windowMs !== "number" || !Number.isFinite(windowMs) || windowMs <= 0) {
      throw new Error(
        `SlotBusyWindows.fromJSON: windowMs must be a positive finite number, got ${JSON.stringify(windowMs)}`,
      );
    }
    // Doubling a float is exact (exponent increment), so an encoder-produced width is an
    // exact power-of-two multiple of the base — same rationale as the timeline's check.
    const widthRatio = windowMs / baseWindowMs;
    if (!Number.isInteger(widthRatio) || widthRatio < 1 || !Number.isInteger(Math.log2(widthRatio))) {
      throw new Error(
        `SlotBusyWindows.fromJSON: windowMs ${windowMs} is not baseWindowMs ${baseWindowMs} times a power of two`,
      );
    }
    const maxWindows = p.maxWindows;
    if (typeof maxWindows !== "number" || !Number.isSafeInteger(maxWindows) || maxWindows < 1) {
      throw new Error(
        `SlotBusyWindows.fromJSON: maxWindows must be a positive safe integer, got ${JSON.stringify(maxWindows)}`,
      );
    }
    if (!Array.isArray(p.windows)) {
      throw new Error(
        `SlotBusyWindows.fromJSON: windows must be an array of [windowIndex, busyMs] pairs, got ${JSON.stringify(p.windows)}`,
      );
    }
    const out = new SlotBusyWindows(baseWindowMs, maxWindows);
    out.windowMs = windowMs;
    let prevIdx = Number.NEGATIVE_INFINITY;
    for (const entry of p.windows) {
      if (!Array.isArray(entry) || entry.length !== 2) {
        throw new Error(
          `SlotBusyWindows.fromJSON: windows entries must be [windowIndex, busyMs] pairs, got ${JSON.stringify(entry)}`,
        );
      }
      const idx: unknown = entry[0];
      const busy: unknown = entry[1];
      if (typeof idx !== "number" || !Number.isSafeInteger(idx) || idx < 0 || idx >= maxWindows) {
        throw new Error(
          `SlotBusyWindows.fromJSON: window index must be an integer in [0, maxWindows), got ${JSON.stringify(idx)}`,
        );
      }
      if (idx <= prevIdx) {
        throw new Error(
          `SlotBusyWindows.fromJSON: window indices must be strictly ascending (canonical form), got ${idx} after ${prevIdx}`,
        );
      }
      prevIdx = idx;
      if (typeof busy !== "number" || !Number.isFinite(busy) || busy < 0) {
        throw new Error(
          `SlotBusyWindows.fromJSON: window ${idx} busyMs must be a non-negative finite number, got ${JSON.stringify(busy)}`,
        );
      }
      out.windows.set(idx, busy);
    }
    return out;
  }
}
