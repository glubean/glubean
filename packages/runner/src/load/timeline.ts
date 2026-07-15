/**
 * Streaming over-time series for the load reducer.
 *
 * Buckets the run into fixed-width windows (from run start) so a consumer can draw the
 * classic load curves: RPS, error-rate, latency percentiles, and concurrency vs time.
 * Memory is bounded: windows start at `baseWindowMs` and, once they would exceed
 * `maxWindows`, the width is DOUBLED and adjacent windows merged pairwise — so an
 * arbitrarily long run keeps at most `maxWindows` windows. Each window keeps a bounded
 * `LoadHistogram` for its latency percentiles (mergeable, so coarsening folds cleanly).
 *
 * For distributed execution the timeline is also a partial aggregate: `toJSON`/`fromJSON`
 * carry it across the wire losslessly, and `merge`/`mergeAll` fold N workers' timelines
 * into one — same `baseWindowMs`, widths aligned by coarsening, per-window counts summed,
 * peaks folded into observed-contributor BOUNDS, lost workers censored at their
 * observation cutoff (internal load-distributed-execution proposal §7.3).
 */
import { LoadHistogram, type LoadHistogramJSON } from "./histogram.js";
import type { LoadTimeline as LoadTimelineArtifact, LoadTimelineWindow, Percentiles } from "@glubean/sdk/load";

const ZERO_PCT: Percentiles = { p50: 0, p90: 0, p95: 0, p99: 0, max: 0 };

/** The one relativeError every timeline window histogram carries. `newWindow()` constructs
 *  `LoadHistogram()` with its default, and coarsening / merging folds revived wire
 *  histograms into such fresh instances — a differing relativeError would make those folds
 *  throw mid-operation, so `fromJSON` pins window histograms to this value. Derived from a
 *  probe instance rather than a copied literal so it cannot drift from histogram.ts. */
const WINDOW_HISTOGRAM_RELATIVE_ERROR = new LoadHistogram().toJSON().relativeError;

interface Window {
  requests: number;
  errors: number;
  latency: LoadHistogram;
  starts: number; // iteration:start in this window — for the carried-in-flight baseline
  iterations: number; // iteration:end in this window (completed; includes endedUnknown closures)
  // Bounds on the max live in-flight sampled at this window's events (a start or a
  // request), EXCLUDING the carried-in baseline (finalize folds that in). In-flight only
  // ever RISES at a start, which is always sampled, so for a single source the sample is
  // the window's exact event-time peak and lower === upper — this captures intra-window
  // concurrency the net (starts − ends) would cancel out, e.g. a short iteration that
  // starts and ends within one (possibly coarsened) window. merge() folds cross-source
  // bounds: max on the lower side, sum on the upper (§7.3) — hence a pair, not a scalar.
  peakLower: number;
  peakUpper: number;
  // Completions synthesized by a censored merge: a lost source's starts still in flight
  // at its observation cutoff are closed here (counted into `iterations` too) so they
  // cannot ghost-carry into later windows. Zero outside censored merges.
  endedUnknown: number;
}

function newWindow(): Window {
  return {
    requests: 0,
    errors: 0,
    latency: new LoadHistogram(),
    starts: 0,
    iterations: 0,
    peakLower: 0,
    peakUpper: 0,
    endedUnknown: 0,
  };
}

/** Wire form of one recorded (sparse) window inside {@link LoadTimelineJSON}. */
export interface LoadTimelineWindowJSON {
  requests: number;
  errors: number;
  starts: number;
  iterations: number;
  /** Censored completions counted into `iterations` by a cutoff merge (see `merge`). */
  endedUnknown: number;
  /** Sampled / merge-folded peak in-flight bounds (single source: lower === upper). */
  peakLower: number;
  peakUpper: number;
  latency: LoadHistogramJSON;
}

/**
 * Versioned wire form of a {@link LoadTimeline} (a worker serializes its reducer's
 * timeline, the coordinator revives and merges it — the round-trip is lossless, so
 * partial aggregation loses nothing).
 *
 * `windows` encodes the sparse window map as `[windowIndex, window]` pairs in strictly
 * ascending index order, and `contributorCutoffsMs` is ascending — canonical form, so
 * equal timelines produce byte-identical payloads (same ethos as
 * {@link LoadHistogramJSON}).
 */
export interface LoadTimelineJSON {
  /** Payload schema version; `fromJSON` rejects anything it does not recognize. */
  v: 1;
  baseWindowMs: number;
  /** Current window width — always baseWindowMs · 2ⁿ (n = coarsening rounds so far). */
  windowMs: number;
  maxWindows: number;
  /** Sparse `[windowIndex, window]` pairs, strictly ascending, index < maxWindows. */
  windows: [number, LoadTimelineWindowJSON][];
  /** Contributors with complete observation (a fresh timeline is 1 — itself). */
  fullContributors: number;
  /** Observation cutoffs (ms offsets) of censored contributors, ascending. Kept in ms —
   *  not window indices — so the values survive coarsening unchanged. */
  contributorCutoffsMs: number[];
}

export class LoadTimeline {
  private windowMs: number;
  // Sparse: only windows with activity exist; finalize() fills the gaps with zeros so the
  // emitted series is dense (a contiguous x-axis).
  private windows = new Map<number, Window>();
  /** Contributors whose observation covers the whole run (a fresh timeline: itself). */
  private fullContributors = 1;
  /** Observation cutoffs (ms) of censored contributors — each covers windows only up to
   *  the window containing its cutoff. Ascending (a maintained invariant). */
  private contributorCutoffsMs: number[] = [];

  /** @param baseWindowMs initial window width (ms). @param maxWindows coarsening cap. */
  constructor(
    private readonly baseWindowMs = 250,
    private readonly maxWindows = 600,
  ) {
    this.windowMs = baseWindowMs;
  }

  /** The window index covering `offsetMs` (ms from run start), coarsening first if the
   *  index would exceed the cap (so the series stays ≤ maxWindows). */
  private indexFor(offsetMs: number): number {
    let idx = Math.floor(Math.max(0, offsetMs) / this.windowMs);
    while (idx >= this.maxWindows) {
      this.coarsen();
      idx = Math.floor(Math.max(0, offsetMs) / this.windowMs);
    }
    return idx;
  }

  /** The LAST window covered by a run of length `runEndMs` (the run spans [0, runEndMs)), or
   *  -1 for a non-positive length. A run ending exactly on a boundary (runEndMs = k·windowMs)
   *  covers windows 0..k-1, NOT a window that starts at the run end (codex). Coarsens so the
   *  index fits the cap. */
  private runEndIndex(runEndMs: number): number {
    if (runEndMs <= 0) return -1;
    while (Math.ceil(runEndMs / this.windowMs) - 1 >= this.maxWindows) this.coarsen();
    return Math.ceil(runEndMs / this.windowMs) - 1;
  }

  /** The window covering `offsetMs`, creating it if absent. */
  private windowFor(offsetMs: number): Window {
    const idx = this.indexFor(offsetMs);
    let w = this.windows.get(idx);
    if (w === undefined) {
      w = newWindow();
      this.windows.set(idx, w);
    }
    return w;
  }

  /** Double the window width and merge each adjacent pair (2k, 2k+1 → k). All folds are
   *  commutative (sum / max / histogram merge), so Map iteration order is irrelevant. The
   *  peak bounds fold with max on BOTH sides: the doubled window's true peak is the max of
   *  the two halves' peaks, so each half's lower/upper bound bounds it. Contributor
   *  cutoffs are in ms and need no rescaling. */
  private coarsen(): void {
    const next = new Map<number, Window>();
    for (const [i, w] of this.windows) {
      const ni = Math.floor(i / 2);
      const existing = next.get(ni);
      if (existing === undefined) {
        next.set(ni, w);
      } else {
        existing.requests += w.requests;
        existing.errors += w.errors;
        existing.starts += w.starts;
        existing.iterations += w.iterations;
        existing.endedUnknown += w.endedUnknown;
        if (w.peakLower > existing.peakLower) existing.peakLower = w.peakLower;
        if (w.peakUpper > existing.peakUpper) existing.peakUpper = w.peakUpper;
        existing.latency.merge(w.latency);
      }
    }
    this.windows = next;
    this.windowMs *= 2;
  }

  /** Record one request observation at `offsetMs`. `inFlight` is the live iteration count
   *  at that moment — sampled so a window busy with requests (e.g. a poll) shows concurrency. */
  recordRequest(offsetMs: number, durationMs: number, ok: boolean, inFlight: number): void {
    const w = this.windowFor(offsetMs);
    w.requests += 1;
    if (!ok) w.errors += 1;
    w.latency.record(durationMs);
    if (inFlight > w.peakLower) w.peakLower = inFlight;
    if (inFlight > w.peakUpper) w.peakUpper = inFlight;
  }

  /** Record one started iteration at `offsetMs`. `inFlight` is the live count just after the
   *  start (its local peak), sampled so even a same-window start+end shows its concurrency. */
  recordIterationStart(offsetMs: number, inFlight: number): void {
    const w = this.windowFor(offsetMs);
    w.starts += 1;
    if (inFlight > w.peakLower) w.peakLower = inFlight;
    if (inFlight > w.peakUpper) w.peakUpper = inFlight;
  }

  /** Record one completed iteration (iteration:end) at `offsetMs`. */
  recordIterationEnd(offsetMs: number): void {
    this.windowFor(offsetMs).iterations += 1;
  }

  /**
   * Fold another timeline (same `baseWindowMs`) into this one — the coordinator's
   * cross-worker combine (§7.3). Width alignment: the finer side is coarsened to the
   * coarser (this one via `coarsen()`, `other` folded on the fly — `other` is NEVER
   * mutated), then widened further if the union would exceed this timeline's
   * `maxWindows` cap. Per window: requests/errors/starts/iterations/endedUnknown sum,
   * latency histograms merge (exact), and the peaks become BOUNDS — the two sides' peaks
   * can occur at different instants, so lower = max(sides) ∨ the combined carried-in
   * count and upper = sum(sides), each side's window peak taken as its stored bounds ∨
   * its own carried-in count (an idle-but-carrying window's in-flight is exactly its
   * carry).
   *
   * SAME-ORIGIN IS THE CALLER'S CONTRACT: a timeline only carries offsets from its time
   * origin (no epoch), so it cannot verify both sides measured against the same
   * `timelineOrigin` — merging differently-anchored timelines silently misaligns windows.
   *
   * `opts.observationCutoffMs` censors a LOST source (§7.3). The cutoff is the source
   * snapshot's observedAt — the instant the worker's LAST snapshot was serialized — so
   * by construction the snapshot holds no event past it. Resolution is one window
   * (matching the timeline's point-estimated precision claim): the cutoff window folds
   * in WHOLE — all of its content precedes the cutoff, there is nothing sub-window to
   * truncate — and `other`'s starts still in flight at the cutoff are closed as
   * `endedUnknown` completions IN that window, so the merged carried-in-flight baseline
   * after the cutoff carries no ghost concurrency. Data in windows PAST the cutoff
   * window can only mean the caller passed a cutoff earlier than the snapshot's actual
   * coverage — misuse, rejected (before any mutation, like every other merge failure).
   * The censored contributor then counts toward per-window contributor coverage only up
   * to its cutoff window — later windows report `contributorsPartial` and their peak
   * bounds cover observed contributors only.
   *
   * All validation happens BEFORE any state mutation — a failed merge must not leave
   * `this` half-merged (same discipline as {@link LoadHistogram.merge}; count overflow is
   * pre-simulated because the histogram's own guard only fires mid-fold). relativeError
   * mismatch is impossible by construction: every window histogram is pinned to the
   * default (`fromJSON` enforces it on revived payloads).
   */
  merge(other: LoadTimeline, opts: { observationCutoffMs?: number } = {}): void {
    if (other === this) {
      throw new Error("LoadTimeline.merge: cannot merge a timeline into itself");
    }
    if (other.baseWindowMs !== this.baseWindowMs) {
      throw new Error(
        `LoadTimeline.merge: baseWindowMs mismatch (${this.baseWindowMs} vs ${other.baseWindowMs}) — merged timelines must share one window grid`,
      );
    }
    // Censoring works on a deep copy (validates the cutoff; `other` stays untouched).
    const src =
      opts.observationCutoffMs !== undefined
        ? LoadTimeline.censoredClone(other, opts.observationCutoffMs)
        : other;
    // Target width: the coarser of the two, widened until the union's last window fits
    // this timeline's cap (the same bound indexFor enforces during recording).
    let targetMs = Math.max(this.windowMs, src.windowMs);
    const lastIdxAt = (t: LoadTimeline, widthMs: number): number => {
      let last = -1;
      const ratio = widthMs / t.windowMs;
      for (const i of t.windows.keys()) {
        const folded = Math.floor(i / ratio);
        if (folded > last) last = folded;
      }
      return last;
    };
    while (Math.max(lastIdxAt(this, targetMs), lastIdxAt(src, targetMs)) >= this.maxWindows) {
      targetMs *= 2;
    }
    this.simulateMergeCounts(src, targetMs); // throws on count overflow — before any mutation
    // --- validation done; nothing below throws ---
    while (this.windowMs < targetMs) this.coarsen();
    // Pre-fold src's windows to the target width (sum counts, max peaks — the same
    // per-source time-wise fold coarsen() uses; histograms kept as refs, merged below).
    const ratio = this.windowMs / src.windowMs; // an exact power of 2 ≥ 1 (both are baseWindowMs·2ⁿ)
    const srcFolded = new Map<
      number,
      Omit<LoadTimelineWindowJSON, "latency"> & { hists: LoadHistogram[] }
    >();
    for (const i of [...src.windows.keys()].sort((a, b) => a - b)) {
      const w = src.windows.get(i)!;
      const t = Math.floor(i / ratio);
      const f = srcFolded.get(t);
      if (f === undefined) {
        srcFolded.set(t, {
          requests: w.requests,
          errors: w.errors,
          starts: w.starts,
          iterations: w.iterations,
          endedUnknown: w.endedUnknown,
          peakLower: w.peakLower,
          peakUpper: w.peakUpper,
          hists: [w.latency],
        });
      } else {
        f.requests += w.requests;
        f.errors += w.errors;
        f.starts += w.starts;
        f.iterations += w.iterations;
        f.endedUnknown += w.endedUnknown;
        if (w.peakLower > f.peakLower) f.peakLower = w.peakLower;
        if (w.peakUpper > f.peakUpper) f.peakUpper = w.peakUpper;
        f.hists.push(w.latency);
      }
    }
    // Walk the union ascending, tracking each side's carried-in count (it only changes at
    // windows that have an entry, so walking entries suffices). Windows where NEITHER
    // side has an entry stay absent — their union peak is exactly the combined carry,
    // which finalize() derives from the summed starts/iterations.
    const targets = [...new Set([...this.windows.keys(), ...srcFolded.keys()])].sort(
      (a, b) => a - b,
    );
    let carryThis = 0;
    let carrySrc = 0;
    for (const t of targets) {
      const mine = this.windows.get(t);
      const theirs = srcFolded.get(t);
      // Carry deltas snapshotted BEFORE the fold mutates `mine`.
      const dThis = mine === undefined ? 0 : mine.starts - mine.iterations;
      const dSrc = theirs === undefined ? 0 : theirs.starts - theirs.iterations;
      // Each side's window-peak bounds given what it knows: stored bounds ∨ its own carry.
      const thisLower = Math.max(mine?.peakLower ?? 0, carryThis);
      const thisUpper = Math.max(mine?.peakUpper ?? 0, carryThis);
      const srcLower = Math.max(theirs?.peakLower ?? 0, carrySrc);
      const srcUpper = Math.max(theirs?.peakUpper ?? 0, carrySrc);
      let w = mine;
      if (w === undefined) {
        w = newWindow();
        this.windows.set(t, w);
      }
      if (theirs !== undefined) {
        w.requests += theirs.requests;
        w.errors += theirs.errors;
        w.starts += theirs.starts;
        w.iterations += theirs.iterations;
        w.endedUnknown += theirs.endedUnknown;
        for (const h of theirs.hists) w.latency.merge(h); // cannot throw: pre-simulated
      }
      // Cross-source peak fold (§7.3): peaks can occur at different instants, so only
      // bounds survive — max (∨ the combined entry in-flight) below, sum above.
      w.peakLower = Math.max(thisLower, srcLower, carryThis + carrySrc);
      w.peakUpper = thisUpper + srcUpper;
      carryThis += dThis;
      carrySrc += dSrc;
    }
    this.fullContributors += src.fullContributors;
    if (src.contributorCutoffsMs.length > 0) {
      this.contributorCutoffsMs = [...this.contributorCutoffsMs, ...src.contributorCutoffsMs].sort(
        (a, b) => a - b,
      );
    }
  }

  /**
   * One-shot coordinator fold: merge every part — each optionally censored at its own
   * observation cutoff — into a FRESH timeline, leaving all inputs untouched. This is the
   * form the coordinator's final aggregation wants (§7.5 folds the last valid snapshot of
   * every worker once, at report time — not incremental pairwise accumulation), and
   * unlike seeding `merge()` with parts[0] it can censor the FIRST part too (any worker
   * can be the lost one). Pairwise `merge()` stays the algebra primitive underneath.
   *
   * ORDER-INDEPENDENT (codex R1): workers arrive in arbitrary order, so the fold is two
   * phases, each order-free, hence the whole is —
   *  1. per part, INDEPENDENTLY: censor → clone → coarsen to the target width. The
   *     target width (the coarsest part's, widened until the union's last window fits
   *     the cap) and the cap (the minimum of the parts' maxWindows — honoring every
   *     part's memory bound) are functions of the part SET, not the order;
   *  2. equal-width fold into a fresh accumulator: per-window ops are commutative and
   *     associative — count/census sums, lower = max of per-part window peaks ∨ the
   *     total carry, upper = their sum, histogram bucket-count sums.
   * Naive sequential `merge()` instead coarsens the partially-merged state when it meets
   * a coarser part, so already-merged bounds got folded at a different granularity per
   * order. Caveat: the histograms' float `sum` aggregate is order-independent only up to
   * float-addition rounding (buckets/min/max — everything the artifact's percentiles
   * derive from — are exact integers and exactly order-independent).
   *
   * A single part folds to an exact clone (censored if a cutoff is given).
   */
  static mergeAll(
    parts: ReadonlyArray<{ timeline: LoadTimeline; observationCutoffMs?: number }>,
  ): LoadTimeline {
    if (parts.length === 0) {
      throw new Error("LoadTimeline.mergeAll: needs at least one part");
    }
    const base = parts[0].timeline.baseWindowMs;
    for (const part of parts) {
      if (part.timeline.baseWindowMs !== base) {
        throw new Error(
          `LoadTimeline.mergeAll: baseWindowMs mismatch (${base} vs ${part.timeline.baseWindowMs}) — merged timelines must share one window grid`,
        );
      }
    }
    // Phase 1 — independent per part (order-free): censor/clone, then coarsen to the
    // set-derived target width.
    const clones = parts.map((part) =>
      part.observationCutoffMs !== undefined
        ? LoadTimeline.censoredClone(part.timeline, part.observationCutoffMs)
        : LoadTimeline.fromJSON(part.timeline.toJSON()),
    );
    if (clones.length === 1) return clones[0];
    const capWindows = Math.min(...clones.map((c) => c.maxWindows));
    let targetMs = Math.max(...clones.map((c) => c.windowMs));
    const unionLastIdx = (widthMs: number): number =>
      Math.max(
        ...clones.map((c) => {
          let last = -1;
          const ratio = widthMs / c.windowMs;
          for (const i of c.windows.keys()) {
            const folded = Math.floor(i / ratio);
            if (folded > last) last = folded;
          }
          return last;
        }),
      );
    while (unionLastIdx(targetMs) >= capWindows) targetMs *= 2;
    for (const c of clones) while (c.windowMs < targetMs) c.coarsen();
    // Phase 2 — equal-width fold. Every clone already sits at targetMs under the cap, so
    // no merge() below ever coarsens the partially-merged state (the order hazard).
    const acc = new LoadTimeline(base, capWindows);
    acc.windowMs = targetMs;
    acc.fullContributors = 0; // the accumulator itself is not a contributor
    for (const c of clones) acc.merge(c);
    return acc;
  }

  /** A censored deep copy of `t` (never mutated), for folding a LOST worker's LAST
   *  snapshot into a merge. `cutoffMs` is that snapshot's observedAt — the instant it
   *  was serialized — so by construction the snapshot holds no event past it, and the
   *  effective resolution is one window: the cutoff window is kept WHOLE (everything in
   *  it precedes the cutoff; there is nothing sub-window to truncate), and the starts
   *  still in flight at the cutoff (total starts − total ends, ≥ 0 because an iteration
   *  cannot end before it starts) are closed as `endedUnknown` completions IN the cutoff
   *  window, zeroing the copy's carried-in contribution past the cutoff. Data in windows
   *  PAST the cutoff window can only mean the caller passed a cutoff earlier than the
   *  snapshot's actual coverage — misuse, rejected before any state is touched. Every
   *  contributor of the copy is censored at (at most) `cutoffMs`. */
  private static censoredClone(t: LoadTimeline, cutoffMs: number): LoadTimeline {
    if (typeof cutoffMs !== "number" || !Number.isFinite(cutoffMs) || cutoffMs < 0) {
      throw new Error(
        `LoadTimeline: observationCutoffMs must be a non-negative finite number, got ${JSON.stringify(cutoffMs)}`,
      );
    }
    // Misuse guard (codex R2): a real last-snapshot cannot contain events after its own
    // observedAt, so recorded data past the cutoff window means the cutoff is wrong.
    const cutIdx = Math.floor(cutoffMs / t.windowMs);
    let lastIdx = -1;
    for (const i of t.windows.keys()) if (i > lastIdx) lastIdx = i;
    if (lastIdx > cutIdx) {
      throw new Error(
        `LoadTimeline: observationCutoffMs ${cutoffMs} predates the snapshot's observation coverage (data through window ${lastIdx}, cutoff window ${cutIdx}) — the cutoff must be the snapshot's observedAt, at or after everything it recorded`,
      );
    }
    const clone = LoadTimeline.fromJSON(t.toJSON()); // lossless round-trip = deep copy
    let starts = 0;
    let ended = 0;
    for (const w of clone.windows.values()) {
      starts += w.starts;
      ended += w.iterations;
    }
    const inFlightAtCutoff = starts - ended;
    if (inFlightAtCutoff > 0) {
      const w = clone.windowFor(cutoffMs); // may coarsen if the cutoff is far past the cap
      w.iterations += inFlightAtCutoff;
      w.endedUnknown += inFlightAtCutoff;
    }
    clone.contributorCutoffsMs = [
      ...clone.contributorCutoffsMs.map((c) => Math.min(c, cutoffMs)),
      ...new Array<number>(clone.fullContributors).fill(cutoffMs),
    ].sort((a, b) => a - b);
    clone.fullContributors = 0;
    return clone;
  }

  /** Dry-run, in plain number space, every addition the pending merge will perform —
   *  this timeline's own coarsening folds to `targetMs`, `src`'s windows folded in
   *  ascending order, the union fold (including the carry-inclusive peak-upper sums) and
   *  the contributor census — on the same float values, throwing the MAX_SAFE_INTEGER
   *  refusal {@link LoadHistogram.merge} applies to its counts, but BEFORE any mutation.
   *  The histogram's own guard only covers ITS count and only fires mid-fold (leaving
   *  `this` half-merged); the window counters, peak upper bounds and fullContributors
   *  have no runtime guard at all — near-2^53 sums would silently leave the exact-integer
   *  domain and the merged timeline's own `fromJSON` would then reject its `toJSON`
   *  (codex R3, the histogram-R13 pattern). The bound is physically unreachable for a
   *  real run — see the histogram's count domain contract. */
  private simulateMergeCounts(src: LoadTimeline, targetMs: number): void {
    const guarded = (what: string, a: number, b: number): number => {
      if (a + b > Number.MAX_SAFE_INTEGER) {
        throw new Error(
          `cannot merge LoadTimelines: combined ${what} ${a} + ${b} exceeds MAX_SAFE_INTEGER (physically unreachable for a real run — see LoadHistogram's count domain contract)`,
        );
      }
      return a + b;
    };
    // A numeric mirror of a window: every field the fold sums (peakLower is only ever
    // max-folded and bounded by peakUpper, so it needs no mirror of its own).
    interface Mirror {
      requests: number;
      errors: number;
      starts: number;
      iterations: number;
      endedUnknown: number;
      latencyCount: number;
      peakUpper: number;
    }
    const mirrorOf = (w: Window): Mirror => ({
      requests: w.requests,
      errors: w.errors,
      starts: w.starts,
      iterations: w.iterations,
      endedUnknown: w.endedUnknown,
      latencyCount: w.latency.count,
      peakUpper: w.peakUpper,
    });
    // The same-side pairwise fold (coarsening / width alignment): counts sum, peaks max.
    const foldPair = (x: Mirror, y: Mirror): Mirror => ({
      requests: guarded("requests count", x.requests, y.requests),
      errors: guarded("errors count", x.errors, y.errors),
      starts: guarded("starts count", x.starts, y.starts),
      iterations: guarded("iterations count", x.iterations, y.iterations),
      endedUnknown: guarded("endedUnknown count", x.endedUnknown, y.endedUnknown),
      latencyCount: guarded("latency count", x.latencyCount, y.latencyCount),
      peakUpper: Math.max(x.peakUpper, y.peakUpper),
    });
    // 1) this side, coarsened level by level to targetMs (mirrors coarsen()).
    let mine = new Map<number, Mirror>();
    for (const [i, w] of this.windows) mine.set(i, mirrorOf(w));
    let widthMs = this.windowMs;
    while (widthMs < targetMs) {
      const next = new Map<number, Mirror>();
      for (const [i, m] of mine) {
        const ni = Math.floor(i / 2);
        const existing = next.get(ni);
        next.set(ni, existing === undefined ? m : foldPair(existing, m));
      }
      mine = next;
      widthMs *= 2;
    }
    // 2) src side, folded to the target width in ascending order (mirrors the pre-fold).
    const ratio = targetMs / src.windowMs;
    const theirs = new Map<number, Mirror>();
    for (const i of [...src.windows.keys()].sort((a, b) => a - b)) {
      const t = Math.floor(i / ratio);
      const m = mirrorOf(src.windows.get(i)!);
      const existing = theirs.get(t);
      theirs.set(t, existing === undefined ? m : foldPair(existing, m));
    }
    // 3) the union fold, with the same carry walk merge() runs: the cross-side count
    //    sums and the carry-inclusive peak-upper sum (which also bounds the lower fold's
    //    carry sum, since each side's upper is ≥ its carry).
    const targets = [...new Set([...mine.keys(), ...theirs.keys()])].sort((a, b) => a - b);
    let carryThis = 0;
    let carrySrc = 0;
    for (const t of targets) {
      const a = mine.get(t);
      const b = theirs.get(t);
      guarded("requests count", a?.requests ?? 0, b?.requests ?? 0);
      guarded("errors count", a?.errors ?? 0, b?.errors ?? 0);
      guarded("starts count", a?.starts ?? 0, b?.starts ?? 0);
      guarded("iterations count", a?.iterations ?? 0, b?.iterations ?? 0);
      guarded("endedUnknown count", a?.endedUnknown ?? 0, b?.endedUnknown ?? 0);
      guarded("latency count", a?.latencyCount ?? 0, b?.latencyCount ?? 0);
      guarded(
        "peak in-flight upper bound",
        Math.max(a?.peakUpper ?? 0, carryThis),
        Math.max(b?.peakUpper ?? 0, carrySrc),
      );
      carryThis += a === undefined ? 0 : a.starts - a.iterations;
      carrySrc += b === undefined ? 0 : b.starts - b.iterations;
    }
    // 4) the contributor census.
    guarded("fullContributors", this.fullContributors, src.fullContributors);
  }

  /** Serialize to the versioned wire form ({@link LoadTimelineJSON}); also the
   *  `JSON.stringify` hook, so a timeline embedded in a larger payload just works. */
  toJSON(): LoadTimelineJSON {
    return {
      v: 1,
      baseWindowMs: this.baseWindowMs,
      windowMs: this.windowMs,
      maxWindows: this.maxWindows,
      windows: [...this.windows.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([i, w]): [number, LoadTimelineWindowJSON] => [
          i,
          {
            requests: w.requests,
            errors: w.errors,
            starts: w.starts,
            iterations: w.iterations,
            endedUnknown: w.endedUnknown,
            peakLower: w.peakLower,
            peakUpper: w.peakUpper,
            latency: w.latency.toJSON(),
          },
        ]),
      fullContributors: this.fullContributors,
      contributorCutoffsMs: [...this.contributorCutoffsMs], // ascending by invariant
    };
  }

  /**
   * Revive a timeline from its wire form. Throws (with the offending field) on any
   * malformed or unknown-version payload — never coerces silently.
   *
   * TRUST MODEL (owner decision, 2026-07-14): payloads originate from same-version
   * cooperating workers (in-process/child-process in D1; version+manifest-verified agents
   * in D2). Validation guards against schema drift and transport corruption, NOT
   * adversarial forgery — exhaustive cross-field feasibility checks (the sum-envelope
   * style of {@link LoadHistogram.fromJSON}) are deliberately out of scope here. Do not
   * add them in review: what is checked is structure, types, per-field domains, canonical
   * ordering, and the operational invariants merge/coarsen actually rely on (the width
   * being baseWindowMs·2ⁿ; window histograms pinned to the default relativeError so folds
   * into freshly constructed instances cannot throw mid-operation).
   */
  static fromJSON(json: unknown): LoadTimeline {
    if (typeof json !== "object" || json === null || Array.isArray(json)) {
      const got = json === null ? "null" : Array.isArray(json) ? "an array" : typeof json;
      throw new Error(`LoadTimeline.fromJSON: payload must be an object, got ${got}`);
    }
    const p = json as Record<string, unknown>;
    // Version first: an unknown version must fail as such, not as random shape drift.
    if (p.v !== 1) {
      throw new Error(
        `LoadTimeline.fromJSON: unsupported payload version ${JSON.stringify(p.v)} (expected 1)`,
      );
    }
    const baseWindowMs = p.baseWindowMs;
    if (typeof baseWindowMs !== "number" || !Number.isFinite(baseWindowMs) || baseWindowMs <= 0) {
      throw new Error(
        `LoadTimeline.fromJSON: baseWindowMs must be a positive finite number, got ${JSON.stringify(baseWindowMs)}`,
      );
    }
    const windowMs = p.windowMs;
    if (typeof windowMs !== "number" || !Number.isFinite(windowMs) || windowMs <= 0) {
      throw new Error(
        `LoadTimeline.fromJSON: windowMs must be a positive finite number, got ${JSON.stringify(windowMs)}`,
      );
    }
    // The width is baseWindowMs after n coarsening doublings. Doubling a float is exact
    // (exponent increment), so windowMs / baseWindowMs is an exact power of two for every
    // encoder-produced payload — no tolerance needed.
    const widthRatio = windowMs / baseWindowMs;
    if (!Number.isInteger(widthRatio) || widthRatio < 1 || !Number.isInteger(Math.log2(widthRatio))) {
      throw new Error(
        `LoadTimeline.fromJSON: windowMs ${windowMs} is not baseWindowMs ${baseWindowMs} times a power of two`,
      );
    }
    const maxWindows = p.maxWindows;
    if (typeof maxWindows !== "number" || !Number.isSafeInteger(maxWindows) || maxWindows < 1) {
      throw new Error(
        `LoadTimeline.fromJSON: maxWindows must be a positive safe integer, got ${JSON.stringify(maxWindows)}`,
      );
    }
    if (!Array.isArray(p.windows)) {
      throw new Error(
        `LoadTimeline.fromJSON: windows must be an array of [windowIndex, window] pairs, got ${JSON.stringify(p.windows)}`,
      );
    }
    const entries: [number, Window][] = [];
    let prevIdx = Number.NEGATIVE_INFINITY;
    for (const entry of p.windows) {
      if (!Array.isArray(entry) || entry.length !== 2) {
        throw new Error(
          `LoadTimeline.fromJSON: windows entries must be [windowIndex, window] pairs, got ${JSON.stringify(entry)}`,
        );
      }
      const idx: unknown = entry[0];
      if (typeof idx !== "number" || !Number.isSafeInteger(idx) || idx < 0 || idx >= maxWindows) {
        throw new Error(
          `LoadTimeline.fromJSON: window index must be an integer in [0, maxWindows), got ${JSON.stringify(idx)}`,
        );
      }
      if (idx <= prevIdx) {
        throw new Error(
          `LoadTimeline.fromJSON: window indices must be strictly ascending (canonical form), got ${idx} after ${prevIdx}`,
        );
      }
      prevIdx = idx;
      const raw = entry[1];
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new Error(
          `LoadTimeline.fromJSON: window ${idx} must be an object, got ${JSON.stringify(raw)}`,
        );
      }
      const wj = raw as Record<string, unknown>;
      // Event counters are exact safe integers (each record() adds 1; merges sum within
      // the histogram-guarded domain) — the same closed count domain as the histogram.
      const count = (field: "requests" | "errors" | "starts" | "iterations" | "endedUnknown"): number => {
        const value = wj[field];
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
          throw new Error(
            `LoadTimeline.fromJSON: window ${idx} ${field} must be a non-negative safe integer, got ${JSON.stringify(value)}`,
          );
        }
        return value;
      };
      const requests = count("requests");
      const errors = count("errors");
      const starts = count("starts");
      const iterations = count("iterations");
      const endedUnknown = count("endedUnknown");
      // Peaks are caller-sampled in-flight counts — the recorder does not constrain them
      // to integers, so the wire requires only finite non-negative and lower ≤ upper.
      const peak = (field: "peakLower" | "peakUpper"): number => {
        const value = wj[field];
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
          throw new Error(
            `LoadTimeline.fromJSON: window ${idx} ${field} must be a non-negative finite number, got ${JSON.stringify(value)}`,
          );
        }
        return value;
      };
      const peakLower = peak("peakLower");
      const peakUpper = peak("peakUpper");
      if (peakLower > peakUpper) {
        throw new Error(
          `LoadTimeline.fromJSON: window ${idx} peakLower ${peakLower} exceeds peakUpper ${peakUpper}`,
        );
      }
      let latency: LoadHistogram;
      try {
        latency = LoadHistogram.fromJSON(wj.latency);
      } catch (e) {
        throw new Error(`LoadTimeline.fromJSON: window ${idx} latency: ${(e as Error).message}`);
      }
      // Pinned relativeError — an OPERATIONAL invariant, not forgery defense: coarsening
      // and merging fold this histogram into freshly constructed default instances, so
      // any other value would throw mid-fold and leave a half-mutated timeline.
      const rel = (wj.latency as Record<string, unknown>).relativeError;
      if (rel !== WINDOW_HISTOGRAM_RELATIVE_ERROR) {
        throw new Error(
          `LoadTimeline.fromJSON: window ${idx} latency relativeError ${JSON.stringify(rel)} is not the timeline's pinned ${WINDOW_HISTOGRAM_RELATIVE_ERROR}`,
        );
      }
      entries.push([
        idx,
        { requests, errors, starts, iterations, endedUnknown, peakLower, peakUpper, latency },
      ]);
    }
    const fullContributors = p.fullContributors;
    if (
      typeof fullContributors !== "number" ||
      !Number.isSafeInteger(fullContributors) ||
      fullContributors < 0
    ) {
      throw new Error(
        `LoadTimeline.fromJSON: fullContributors must be a non-negative safe integer, got ${JSON.stringify(fullContributors)}`,
      );
    }
    if (!Array.isArray(p.contributorCutoffsMs)) {
      throw new Error(
        `LoadTimeline.fromJSON: contributorCutoffsMs must be an array of ms offsets, got ${JSON.stringify(p.contributorCutoffsMs)}`,
      );
    }
    const cutoffs: number[] = [];
    let prevCutoff = Number.NEGATIVE_INFINITY;
    for (const c of p.contributorCutoffsMs) {
      if (typeof c !== "number" || !Number.isFinite(c) || c < 0) {
        throw new Error(
          `LoadTimeline.fromJSON: contributorCutoffsMs entries must be non-negative finite numbers, got ${JSON.stringify(c)}`,
        );
      }
      // Non-strict: two contributors can be lost at the same instant.
      if (c < prevCutoff) {
        throw new Error(
          `LoadTimeline.fromJSON: contributorCutoffsMs must be ascending (canonical form), got ${c} after ${prevCutoff}`,
        );
      }
      prevCutoff = c;
      cutoffs.push(c);
    }
    const t = new LoadTimeline(baseWindowMs, maxWindows);
    t.windowMs = windowMs;
    t.fullContributors = fullContributors;
    t.contributorCutoffsMs = cutoffs;
    for (const [idx, w] of entries) t.windows.set(idx, w);
    return t;
  }

  /** Emit the dense series: every window from 0..last, idle windows zero-filled. `runEndMs`
   *  (the run's `load:end` offset) extends the series to the actual run end, so a trailing
   *  idle / sustained-in-flight period after the last recorded event (an abort, drain timeout,
   *  or hung iteration) is still present instead of being truncated (codex). */
  finalize(runEndMs = 0): LoadTimelineArtifact {
    if (this.windows.size === 0) return { windowMs: this.windowMs, windows: [] };
    // Extend to the last window the run actually covered (may coarsen existing windows).
    let maxIdx = this.runEndIndex(runEndMs);
    for (const i of this.windows.keys()) if (i > maxIdx) maxIdx = i;
    const windowSec = this.windowMs / 1000;
    // Per-window contributor coverage is DERIVED, not stored: a full contributor observed
    // every window — including idle zero-filled ones that have no map entry to hang a
    // stored count on — while a censored one observed only through the window covering
    // its cutoff. A window some contributor did not observe reports contributorsPartial:
    // its peak bounds cover the observed contributors only (§7.3), since the absent
    // contributor's in-flight is unbounded.
    const cutoffIdxs = this.contributorCutoffsMs.map((c) => Math.floor(c / this.windowMs));
    const expectedContributors = this.fullContributors + cutoffIdxs.length;
    const windows: LoadTimelineWindow[] = [];
    // `carriedIn` = in-flight iterations ENTERING each window = Σ(starts − ends) through the
    // PREVIOUS windows (censored ends included — that is exactly what keeps lost workers'
    // ghosts out). The window's reported concurrency folds it into the stored bounds:
    //  - the sampled/merged bounds catch intra-window concurrency the net would cancel (a
    //    short iteration that starts and ends in one window — even after coarsening);
    //  - carriedIn catches a long iteration spanning quiet/idle windows (sustained, not zero).
    let carriedIn = 0;
    for (let i = 0; i <= maxIdx; i++) {
      const w = this.windows.get(i);
      // Single source records lower === upper, so both sides collapse to the exact peak
      // (the historical `peakInFlight` value); merged bounds stay bounds.
      const lower = Math.max(0, w?.peakLower ?? 0, carriedIn);
      const upper = Math.max(0, w?.peakUpper ?? 0, carriedIn);
      const requests = w?.requests ?? 0;
      const errors = w?.errors ?? 0;
      const win: LoadTimelineWindow = {
        offsetMs: i * this.windowMs,
        requests,
        errors,
        errorRate: requests > 0 ? errors / requests : 0,
        throughputPerSec: windowSec > 0 ? requests / windowSec : 0,
        latency: w !== undefined && w.latency.count > 0 ? w.latency.percentiles() : ZERO_PCT,
        iterations: w?.iterations ?? 0,
        peakInFlight: upper, // v1-consumer compatibility scalar — always bounds.upper (§11.1)
        peakInFlightBounds: { lower, upper },
      };
      if (w !== undefined && w.endedUnknown > 0) win.endedUnknown = w.endedUnknown;
      const contributors =
        this.fullContributors + cutoffIdxs.reduce((n, c) => (c >= i ? n + 1 : n), 0);
      if (contributors < expectedContributors) win.contributorsPartial = true;
      windows.push(win);
      carriedIn += (w?.starts ?? 0) - (w?.iterations ?? 0);
    }
    return { windowMs: this.windowMs, windows };
  }

  /** Dense all-zero series over [0, runEndMs) for a timeline that recorded NO windows —
   *  the authoritative-boundary synthesis (`finalize` early-returns EMPTY with no
   *  recorded window, but an idle / lost shard finalized against a coordinator run end
   *  must present the shared axis as "observed idle", not "no axis"). The caller (the
   *  reducer) gates WHEN synthesis applies — only under an explicit authoritative
   *  boundary; this method owns HOW, with the timeline's own coarsening (`runEndIndex`)
   *  and its contributor census. CONTRIBUTOR SEMANTICS ARE PRESERVED (codex R3): a
   *  censored contributor covers only windows up to its cutoff window, so later
   *  synthesized windows report `contributorsPartial` exactly as recorded windows would
   *  — without this, an all-idle censored merge (e.g. every worker lost during ramp)
   *  would synthesize windows that read "fully observed" past every cutoff. Peak
   *  bounds are written as the observed contributors' exact zeros (lower === upper ===
   *  0); under `contributorsPartial` they cover observed contributors only, like every
   *  merged window (§7.3). Empty for a non-positive `runEndMs`. */
  synthesizeZero(runEndMs: number): LoadTimelineArtifact {
    const maxIdx = this.runEndIndex(runEndMs); // coarsens so the index fits the cap
    if (maxIdx < 0) return { windowMs: this.windowMs, windows: [] };
    const cutoffIdxs = this.contributorCutoffsMs.map((c) => Math.floor(c / this.windowMs));
    const expectedContributors = this.fullContributors + cutoffIdxs.length;
    const windows: LoadTimelineWindow[] = [];
    for (let i = 0; i <= maxIdx; i++) {
      const win: LoadTimelineWindow = {
        offsetMs: i * this.windowMs,
        requests: 0,
        errors: 0,
        errorRate: 0,
        throughputPerSec: 0,
        latency: ZERO_PCT,
        iterations: 0,
        peakInFlight: 0,
        peakInFlightBounds: { lower: 0, upper: 0 },
      };
      const contributors =
        this.fullContributors + cutoffIdxs.reduce((n, c) => (c >= i ? n + 1 : n), 0);
      if (contributors < expectedContributors) win.contributorsPartial = true;
      windows.push(win);
    }
    return { windowMs: this.windowMs, windows };
  }
}
