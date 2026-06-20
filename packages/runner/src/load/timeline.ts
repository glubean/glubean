/**
 * Streaming over-time series for the load reducer.
 *
 * Buckets the run into fixed-width windows (from run start) so a consumer can draw the
 * classic load curves: RPS, error-rate, latency percentiles, and concurrency vs time.
 * Memory is bounded: windows start at `baseWindowMs` and, once they would exceed
 * `maxWindows`, the width is DOUBLED and adjacent windows merged pairwise — so an
 * arbitrarily long run keeps at most `maxWindows` windows. Each window keeps a bounded
 * `LoadHistogram` for its latency percentiles (mergeable, so coarsening folds cleanly).
 */
import { LoadHistogram } from "./histogram.js";
import type { LoadTimeline as LoadTimelineArtifact, LoadTimelineWindow, Percentiles } from "@glubean/sdk/load";

const ZERO_PCT: Percentiles = { p50: 0, p90: 0, p95: 0, p99: 0, max: 0 };

interface Window {
  requests: number;
  errors: number;
  latency: LoadHistogram;
  starts: number; // iteration:start in this window — for the carried-in-flight baseline
  iterations: number; // iteration:end in this window (completed)
  // Max live in-flight SAMPLED at this window's events (a start or a request) — captures
  // intra-window concurrency the net (starts − ends) would cancel out, e.g. a short
  // iteration that starts and ends within one (possibly coarsened) window.
  peakSample: number;
}

function newWindow(): Window {
  return { requests: 0, errors: 0, latency: new LoadHistogram(), starts: 0, iterations: 0, peakSample: 0 };
}

export class LoadTimeline {
  private windowMs: number;
  // Sparse: only windows with activity exist; finalize() fills the gaps with zeros so the
  // emitted series is dense (a contiguous x-axis).
  private windows = new Map<number, Window>();

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
   *  commutative (sum / max / histogram merge), so Map iteration order is irrelevant. */
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
        if (w.peakSample > existing.peakSample) existing.peakSample = w.peakSample;
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
    if (inFlight > w.peakSample) w.peakSample = inFlight;
  }

  /** Record one started iteration at `offsetMs`. `inFlight` is the live count just after the
   *  start (its local peak), sampled so even a same-window start+end shows its concurrency. */
  recordIterationStart(offsetMs: number, inFlight: number): void {
    const w = this.windowFor(offsetMs);
    w.starts += 1;
    if (inFlight > w.peakSample) w.peakSample = inFlight;
  }

  /** Record one completed iteration (iteration:end) at `offsetMs`. */
  recordIterationEnd(offsetMs: number): void {
    this.windowFor(offsetMs).iterations += 1;
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
    const windows: LoadTimelineWindow[] = [];
    // `carriedIn` = in-flight iterations ENTERING each window = Σ(starts − ends) through the
    // PREVIOUS windows. The window's reported concurrency is max(its sampled peak, carriedIn):
    //  - the sampled peak catches intra-window concurrency the net would cancel (a short
    //    iteration that starts and ends in one window — even after coarsening);
    //  - carriedIn catches a long iteration spanning quiet/idle windows (sustained, not zero).
    let carriedIn = 0;
    for (let i = 0; i <= maxIdx; i++) {
      const w = this.windows.get(i);
      const peakInFlight = Math.max(0, w?.peakSample ?? 0, carriedIn);
      if (w === undefined) {
        windows.push({
          offsetMs: i * this.windowMs,
          requests: 0,
          errors: 0,
          errorRate: 0,
          throughputPerSec: 0,
          latency: ZERO_PCT,
          iterations: 0,
          peakInFlight,
        });
      } else {
        windows.push({
          offsetMs: i * this.windowMs,
          requests: w.requests,
          errors: w.errors,
          errorRate: w.requests > 0 ? w.errors / w.requests : 0,
          throughputPerSec: windowSec > 0 ? w.requests / windowSec : 0,
          latency: w.latency.count > 0 ? w.latency.percentiles() : ZERO_PCT,
          iterations: w.iterations,
          peakInFlight,
        });
      }
      carriedIn += (w?.starts ?? 0) - (w?.iterations ?? 0);
    }
    return { windowMs: this.windowMs, windows };
  }
}
