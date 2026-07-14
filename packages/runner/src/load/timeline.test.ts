import { describe, it, expect } from "vitest";

import { LoadHistogram } from "./histogram.js";
import { LoadTimeline, type LoadTimelineJSON } from "./timeline.js";

/** Replay a sorted event list into a timeline, tracking the LOCAL live in-flight count —
 *  the same view a worker's reducer has of its own shard (a partition never sees the
 *  other partitions' concurrency; that is exactly what merge() has to reconstruct). */
type ReplayEvent =
  | { at: number; kind: "start" }
  | { at: number; kind: "end" }
  | { at: number; kind: "req"; ms: number; ok: boolean };
function replay(t: LoadTimeline, events: ReplayEvent[]): LoadTimeline {
  let inFlight = 0;
  for (const e of [...events].sort((a, b) => a.at - b.at)) {
    if (e.kind === "start") t.recordIterationStart(e.at, ++inFlight);
    else if (e.kind === "end") {
      inFlight -= 1;
      t.recordIterationEnd(e.at);
    } else t.recordRequest(e.at, e.ms, e.ok, inFlight);
  }
  return t;
}

describe("LoadTimeline", () => {
  it("buckets requests into fixed windows with RPS / errorRate", () => {
    const t = new LoadTimeline(1000, 600); // 1s windows
    t.recordRequest(0, 10, true, 1);
    t.recordRequest(500, 20, false, 1); // same window as 0
    t.recordRequest(2000, 30, true, 1); // window 2 (window 1 idle)
    const tl = t.finalize();
    expect(tl.windowMs).toBe(1000);
    expect(tl.windows).toHaveLength(3); // 0,1,2 dense (window 1 zero-filled)
    expect(tl.windows[0]).toMatchObject({ offsetMs: 0, requests: 2, errors: 1, throughputPerSec: 2 });
    expect(tl.windows[0].errorRate).toBe(0.5);
    expect(tl.windows[0].latency.max).toBe(20);
    expect(tl.windows[1]).toMatchObject({ offsetMs: 1000, requests: 0, throughputPerSec: 0, errorRate: 0 });
    expect(tl.windows[2]).toMatchObject({ offsetMs: 2000, requests: 1 });
  });

  it("zero-fills idle windows so the series is dense (a contiguous x-axis)", () => {
    const t = new LoadTimeline(1000);
    t.recordRequest(0, 5, true, 1);
    t.recordRequest(5000, 5, true, 1); // windows 1-4 are idle
    const tl = t.finalize();
    expect(tl.windows.map((w) => w.requests)).toEqual([1, 0, 0, 0, 0, 1]);
  });

  it("coarsens (doubles the window + merges) to stay bounded for a long run", () => {
    const t = new LoadTimeline(100, 4); // 100ms base, cap 4 windows
    for (let ms = 0; ms <= 700; ms += 100) t.recordRequest(ms, 10, true, 1); // 8 requests over 700ms
    const tl = t.finalize();
    expect(tl.windowMs).toBe(200); // doubled once (8 windows @100ms → 4 @200ms)
    expect(tl.windows.length).toBeLessThanOrEqual(4); // bounded by the cap
    expect(tl.windows.reduce((s, w) => s + w.requests, 0)).toBe(8); // every request preserved
  });

  it("keeps coarsening for a very long run (always bounded)", () => {
    const t = new LoadTimeline(100, 8);
    for (let ms = 0; ms < 100_000; ms += 100) t.recordRequest(ms, 1, true, 1); // 1000 windows worth
    const tl = t.finalize();
    expect(tl.windows.length).toBeLessThanOrEqual(8);
    expect(tl.windows.reduce((s, w) => s + w.requests, 0)).toBe(1000);
  });

  it("carries peak in-flight across idle windows (a long iteration doesn't drop to 0)", () => {
    // codex r1: a long iteration spanning quiet windows must keep the concurrency curve up.
    const t = new LoadTimeline(1000);
    t.recordIterationStart(0, 1);
    t.recordIterationStart(100, 2); // window 0: 2 in-flight
    // window 1: no events — the two iterations are still running
    t.recordIterationEnd(2500);
    t.recordIterationEnd(2600); // window 2: both end
    const tl = t.finalize();
    expect(tl.windows[0].peakInFlight).toBe(2);
    expect(tl.windows[1].peakInFlight).toBe(2); // idle window carries the in-flight count
    expect(tl.windows[2].peakInFlight).toBe(2); // still in-flight until they end in this window
    expect(tl.windows[2].iterations).toBe(2); // 2 completed in window 2
  });

  it("captures concurrency of a short iteration that starts and ends in one window", () => {
    // codex r2: the net (starts − ends) is 0 here, but the sampled peak must still show it.
    const t = new LoadTimeline(1000);
    t.recordIterationStart(0, 1); // live in-flight 1 at the start
    t.recordIterationEnd(100); // ends in the same window — net 0
    const tl = t.finalize();
    expect(tl.windows[0].peakInFlight).toBe(1); // not zero
    expect(tl.windows[0].iterations).toBe(1);
  });

  it("extends the series to the run end so a trailing idle / hung period isn't truncated", () => {
    // codex r3: a 5s run whose only event is one iteration:start must still emit windows through
    // the run end, carrying the (never-ended) in-flight count.
    const t = new LoadTimeline(250, 600);
    t.recordIterationStart(0, 1); // window 0; the iteration never ends (hung / aborted)
    const tl = t.finalize(5000); // load:end at 5s
    expect(tl.windowMs).toBe(250);
    expect(tl.windows).toHaveLength(20); // 0..19 — windows COVERED by [0,5000), not one starting at 5000
    expect(tl.windows[19].offsetMs).toBe(4750); // last window is within the run, < runEnd
    expect(tl.windows.every((w) => w.peakInFlight === 1)).toBe(true); // sustained in-flight to the end
  });

  it("is empty for a run with no events", () => {
    expect(new LoadTimeline().finalize().windows).toEqual([]);
  });

  it("emits exact peak bounds on the single-source path (lower === upper === peakInFlight)", () => {
    // The pre-merge behavior, verbatim: one source records exact peaks, so the new bounds
    // collapse to the historical peakInFlight scalar and no merge-only fields appear.
    const t = replay(new LoadTimeline(1000), [
      { at: 0, kind: "start" },
      { at: 100, kind: "req", ms: 10, ok: true },
      { at: 2500, kind: "end" },
    ]);
    for (const w of t.finalize(4000).windows) {
      // The current emitter always writes bounds (optional in the type only for pre-bounds
      // artifacts, §11.1).
      expect(w.peakInFlightBounds!.lower).toBe(w.peakInFlightBounds!.upper);
      expect(w.peakInFlight).toBe(w.peakInFlightBounds!.upper);
      expect("endedUnknown" in w).toBe(false);
      expect("contributorsPartial" in w).toBe(false);
    }
  });
});

describe("LoadTimeline wire serialization", () => {
  const wire = (): LoadTimelineJSON => {
    const t = new LoadTimeline(250, 600);
    t.recordIterationStart(10, 1);
    t.recordRequest(20, 12, true, 1);
    t.recordRequest(300, 55, false, 1);
    t.recordIterationEnd(400);
    return t.toJSON();
  };

  it("round-trips a recorded timeline byte-identically with an identical finalize", () => {
    const t = replay(new LoadTimeline(250, 600), [
      { at: 0, kind: "start" },
      { at: 40, kind: "req", ms: 8, ok: true },
      { at: 260, kind: "req", ms: 20, ok: false },
      { at: 900, kind: "end" },
      { at: 1000, kind: "start" },
      { at: 1200, kind: "end" },
    ]);
    const revived = LoadTimeline.fromJSON(JSON.parse(JSON.stringify(t))); // via real JSON text
    expect(JSON.stringify(revived.toJSON())).toBe(JSON.stringify(t.toJSON()));
    expect(revived.finalize(2000)).toEqual(t.finalize(2000));
  });

  it("round-trips an empty timeline and a coarsened timeline", () => {
    const empty = new LoadTimeline(100, 8);
    expect(LoadTimeline.fromJSON(empty.toJSON()).finalize()).toEqual(empty.finalize());
    const coarse = new LoadTimeline(100, 8);
    for (let ms = 0; ms < 100_000; ms += 100) coarse.recordRequest(ms, 1, true, 1);
    const revived = LoadTimeline.fromJSON(coarse.toJSON());
    expect(revived.toJSON().windowMs).toBe(coarse.toJSON().windowMs); // baseWindowMs·2ⁿ preserved
    expect(JSON.stringify(revived.toJSON())).toBe(JSON.stringify(coarse.toJSON()));
    expect(revived.finalize()).toEqual(coarse.finalize());
  });

  it("revived timelines keep recording and merging like the original", () => {
    const t = replay(new LoadTimeline(250, 600), [
      { at: 0, kind: "start" },
      { at: 100, kind: "req", ms: 5, ok: true },
    ]);
    const revived = LoadTimeline.fromJSON(t.toJSON());
    revived.recordIterationEnd(300); // continues the run
    t.recordIterationEnd(300);
    expect(revived.finalize(1000)).toEqual(t.finalize(1000));
  });

  it("fromJSON rejects non-object and unknown-version payloads", () => {
    expect(() => LoadTimeline.fromJSON(null)).toThrow(/payload must be an object, got null/);
    expect(() => LoadTimeline.fromJSON([])).toThrow(/payload must be an object, got an array/);
    expect(() => LoadTimeline.fromJSON("x")).toThrow(/payload must be an object, got string/);
    expect(() => LoadTimeline.fromJSON({ ...wire(), v: 2 })).toThrow(
      /unsupported payload version 2/,
    );
    expect(() => LoadTimeline.fromJSON({ ...wire(), v: undefined })).toThrow(
      /unsupported payload version/,
    );
  });

  it("fromJSON rejects malformed top-level fields, naming the field", () => {
    expect(() => LoadTimeline.fromJSON({ ...wire(), baseWindowMs: 0 })).toThrow(
      /baseWindowMs must be a positive finite number/,
    );
    expect(() => LoadTimeline.fromJSON({ ...wire(), baseWindowMs: "250" })).toThrow(
      /baseWindowMs must be a positive finite number/,
    );
    expect(() => LoadTimeline.fromJSON({ ...wire(), windowMs: -250 })).toThrow(
      /windowMs must be a positive finite number/,
    );
    // Width must be baseWindowMs times a power of two (the only widths coarsening produces).
    expect(() => LoadTimeline.fromJSON({ ...wire(), windowMs: 750 })).toThrow(
      /windowMs 750 is not baseWindowMs 250 times a power of two/,
    );
    expect(() => LoadTimeline.fromJSON({ ...wire(), windowMs: 125 })).toThrow(
      /not baseWindowMs 250 times a power of two/,
    );
    expect(() => LoadTimeline.fromJSON({ ...wire(), maxWindows: 0 })).toThrow(
      /maxWindows must be a positive safe integer/,
    );
    expect(() => LoadTimeline.fromJSON({ ...wire(), maxWindows: 1.5 })).toThrow(
      /maxWindows must be a positive safe integer/,
    );
    expect(() => LoadTimeline.fromJSON({ ...wire(), windows: {} })).toThrow(
      /windows must be an array/,
    );
    expect(() => LoadTimeline.fromJSON({ ...wire(), fullContributors: -1 })).toThrow(
      /fullContributors must be a non-negative safe integer/,
    );
    expect(() => LoadTimeline.fromJSON({ ...wire(), contributorCutoffsMs: 5 })).toThrow(
      /contributorCutoffsMs must be an array/,
    );
    expect(() => LoadTimeline.fromJSON({ ...wire(), contributorCutoffsMs: [-1] })).toThrow(
      /contributorCutoffsMs entries must be non-negative finite numbers/,
    );
    expect(() => LoadTimeline.fromJSON({ ...wire(), contributorCutoffsMs: [500, 100] })).toThrow(
      /contributorCutoffsMs must be ascending/,
    );
  });

  it("fromJSON rejects malformed window entries, naming the window", () => {
    const withEntry = (entry: unknown) => ({ ...wire(), windows: [entry] });
    const patchWindow = (patch: Record<string, unknown>) => {
      const j = wire();
      const [idx, w] = j.windows[0];
      return { ...j, windows: [[idx, { ...w, ...patch }]] };
    };
    expect(() => LoadTimeline.fromJSON(withEntry([0]))).toThrow(
      /windows entries must be \[windowIndex, window\] pairs/,
    );
    expect(() => LoadTimeline.fromJSON(withEntry([-1, wire().windows[0][1]]))).toThrow(
      /window index must be an integer in \[0, maxWindows\)/,
    );
    expect(() => LoadTimeline.fromJSON(withEntry([1.5, wire().windows[0][1]]))).toThrow(
      /window index must be an integer/,
    );
    expect(() => LoadTimeline.fromJSON(withEntry([600, wire().windows[0][1]]))).toThrow(
      /window index must be an integer in \[0, maxWindows\)/,
    );
    // Strictly ascending (canonical form).
    const j = wire();
    expect(() =>
      LoadTimeline.fromJSON({ ...j, windows: [j.windows[0], j.windows[0]] }),
    ).toThrow(/window indices must be strictly ascending/);
    expect(() => LoadTimeline.fromJSON(withEntry([0, null]))).toThrow(/window 0 must be an object/);
    expect(() => LoadTimeline.fromJSON(patchWindow({ requests: -1 }))).toThrow(
      /window 0 requests must be a non-negative safe integer/,
    );
    expect(() => LoadTimeline.fromJSON(patchWindow({ errors: 2 ** 53 }))).toThrow(
      /window 0 errors must be a non-negative safe integer/,
    );
    expect(() => LoadTimeline.fromJSON(patchWindow({ starts: 1.5 }))).toThrow(
      /window 0 starts must be a non-negative safe integer/,
    );
    expect(() => LoadTimeline.fromJSON(patchWindow({ iterations: "1" }))).toThrow(
      /window 0 iterations must be a non-negative safe integer/,
    );
    expect(() => LoadTimeline.fromJSON(patchWindow({ endedUnknown: -2 }))).toThrow(
      /window 0 endedUnknown must be a non-negative safe integer/,
    );
    expect(() => LoadTimeline.fromJSON(patchWindow({ peakLower: -1 }))).toThrow(
      /window 0 peakLower must be a non-negative finite number/,
    );
    expect(() => LoadTimeline.fromJSON(patchWindow({ peakUpper: Infinity }))).toThrow(
      /window 0 peakUpper must be a non-negative finite number/,
    );
    expect(() => LoadTimeline.fromJSON(patchWindow({ peakLower: 3, peakUpper: 2 }))).toThrow(
      /window 0 peakLower 3 exceeds peakUpper 2/,
    );
    // Latency sub-payload delegates to LoadHistogram.fromJSON, prefixed with the window.
    expect(() => LoadTimeline.fromJSON(patchWindow({ latency: null }))).toThrow(
      /window 0 latency: LoadHistogram.fromJSON/,
    );
    expect(() =>
      LoadTimeline.fromJSON(patchWindow({ latency: { v: 2 } })),
    ).toThrow(/window 0 latency: LoadHistogram.fromJSON: unsupported payload version/);
  });

  it("fromJSON rejects a window histogram whose relativeError is not the pinned default", () => {
    // Operational, not adversarial: coarsen/merge fold window histograms into freshly
    // constructed default instances — a different relativeError would throw mid-fold.
    const other = new LoadHistogram(0.05);
    other.record(12);
    const j = wire();
    const [idx, w] = j.windows[0];
    expect(() =>
      LoadTimeline.fromJSON({ ...j, windows: [[idx, { ...w, latency: other.toJSON() }]] }),
    ).toThrow(/window 0 latency relativeError 0.05 is not the timeline's pinned 0.01/);
  });
});

describe("LoadTimeline.merge", () => {
  // One event stream, partitioned by iteration across two workers — the distributed
  // acceptance shape (§12 D0): merged counts must equal the single-timeline direct run
  // exactly; peaks can only promise bounds that contain the direct-run truth.
  const A_EVENTS: ReplayEvent[] = [
    { at: 100, kind: "start" }, // X
    { at: 150, kind: "req", ms: 10, ok: true },
    { at: 1100, kind: "start" }, // Z
    { at: 1500, kind: "end" }, // Z
    { at: 2500, kind: "end" }, // X
  ];
  const B_EVENTS: ReplayEvent[] = [
    { at: 200, kind: "start" }, // Y
    { at: 1400, kind: "req", ms: 20, ok: false },
    { at: 3400, kind: "end" }, // Y
    { at: 3600, kind: "req", ms: 30, ok: true },
  ];

  it("partition-then-merge ≡ direct single run for every count; peaks become containing bounds", () => {
    const direct = replay(new LoadTimeline(1000), [...A_EVENTS, ...B_EVENTS]).finalize(5000);
    const a = replay(new LoadTimeline(1000), A_EVENTS);
    a.merge(replay(new LoadTimeline(1000), B_EVENTS));
    const merged = a.finalize(5000);
    expect(merged.windowMs).toBe(direct.windowMs);
    expect(merged.windows).toHaveLength(direct.windows.length);
    merged.windows.forEach((mw, i) => {
      const dw = direct.windows[i];
      // Exact across the partition boundary: counts, rates, and latency (histogram merge
      // is exact — same buckets, same percentiles).
      expect(mw.offsetMs).toBe(dw.offsetMs);
      expect(mw.requests).toBe(dw.requests);
      expect(mw.errors).toBe(dw.errors);
      expect(mw.errorRate).toBe(dw.errorRate);
      expect(mw.throughputPerSec).toBe(dw.throughputPerSec);
      expect(mw.iterations).toBe(dw.iterations);
      expect(mw.latency).toEqual(dw.latency);
      // Bounds contain the direct-run exact peak; the compat scalar is the upper bound.
      expect(mw.peakInFlightBounds!.lower).toBeLessThanOrEqual(dw.peakInFlight);
      expect(mw.peakInFlightBounds!.upper).toBeGreaterThanOrEqual(dw.peakInFlight);
      expect(mw.peakInFlight).toBe(mw.peakInFlightBounds!.upper);
      // Full contributors on both sides: no censoring artifacts anywhere.
      expect("endedUnknown" in mw).toBe(false);
      expect("contributorsPartial" in mw).toBe(false);
    });
    // The bounds themselves, pinned (per-source peaks at different instants stay a real
    // interval in w0; single-side or carry-dominated windows collapse to exact).
    expect(merged.windows.map((w) => w.peakInFlightBounds)).toEqual([
      { lower: 1, upper: 2 },
      { lower: 2, upper: 3 },
      { lower: 2, upper: 2 },
      { lower: 1, upper: 1 },
      { lower: 0, upper: 0 },
    ]);
  });

  it("reconstructs the carried-in-flight curve of the direct run (cross-window iterations on both sides)", () => {
    // Each partition holds one long iteration spanning idle windows; the merged carry
    // curve (visible as idle-window peakInFlight) must equal the direct run's exactly.
    const a = replay(new LoadTimeline(1000), [
      { at: 0, kind: "start" },
      { at: 4500, kind: "end" },
    ]);
    const b = replay(new LoadTimeline(1000), [
      { at: 1200, kind: "start" },
      { at: 5500, kind: "end" },
    ]);
    const direct = replay(new LoadTimeline(1000), [
      { at: 0, kind: "start" },
      { at: 1200, kind: "start" },
      { at: 4500, kind: "end" },
      { at: 5500, kind: "end" },
    ]).finalize(7000);
    a.merge(b);
    const merged = a.finalize(7000);
    // Idle windows (2, 3, 6) carry no samples on either side: the merged window is the
    // combined carry, exact — field-for-field identical to the direct run.
    for (const i of [2, 3, 6]) expect(merged.windows[i]).toEqual(direct.windows[i]);
    expect(merged.windows.map((w) => w.peakInFlightBounds)).toEqual([
      { lower: 1, upper: 1 }, // only A active
      { lower: 1, upper: 2 }, // A carries 1, B samples 1 — peaks may not coincide
      { lower: 2, upper: 2 }, // pure carry: exact
      { lower: 2, upper: 2 },
      { lower: 2, upper: 2 }, // A ends here; entry carry 2 is exact
      { lower: 1, upper: 1 },
      { lower: 0, upper: 0 },
    ]);
    merged.windows.forEach((w, i) => {
      expect(w.iterations).toBe(direct.windows[i].iterations);
      expect(w.peakInFlight).toBe(w.peakInFlightBounds!.upper);
    });
  });

  it("aligns mismatched widths by coarsening to the coarser side (and stays under the cap)", () => {
    const a = new LoadTimeline(500, 4); // coarsens itself: events span 8 base windows
    for (const at of [0, 600, 1700, 3900]) a.recordRequest(at, 5, true, 1);
    expect(a.toJSON().windowMs).toBe(1000); // doubled once
    const b = new LoadTimeline(500, 600); // still at base width
    for (const at of [250, 750, 1250]) b.recordRequest(at, 7, true, 1);
    a.merge(b);
    const merged = a.finalize();
    expect(merged.windowMs).toBe(1000); // b folded 2:1 into a's coarser grid
    expect(merged.windows.map((w) => w.requests)).toEqual([4, 2, 0, 1]);
    expect(merged.windows.reduce((s, w) => s + w.requests, 0)).toBe(7); // nothing lost
  });

  it("widens past both sides when the union would exceed this timeline's cap", () => {
    const a = new LoadTimeline(500, 4);
    a.recordRequest(0, 5, true, 1); // width stays 500, indices 0..0
    const b = new LoadTimeline(500, 600);
    b.recordRequest(7900, 5, true, 1); // index 15 at width 500 — beyond a's cap of 4
    a.merge(b);
    const j = a.toJSON();
    expect(j.windowMs).toBe(2000); // 500 → 1000 (idx 7) still ≥ 4 → 2000 (idx 3)
    expect(a.finalize().windows.map((w) => w.requests)).toEqual([1, 0, 0, 1]);
  });

  it("sums contributor censuses (merging already-merged timelines)", () => {
    const mk = () => replay(new LoadTimeline(1000), [{ at: 0, kind: "req", ms: 1, ok: true }]);
    const ab = mk();
    ab.merge(mk());
    const cd = mk();
    cd.merge(mk(), { observationCutoffMs: 500 });
    ab.merge(cd);
    const j = ab.toJSON();
    expect(j.fullContributors).toBe(3); // a, b, c
    expect(j.contributorCutoffsMs).toEqual([500]); // d, censored
  });

  it("rejects a baseWindowMs mismatch before any state mutation", () => {
    const a = replay(new LoadTimeline(250), [{ at: 0, kind: "req", ms: 5, ok: true }]);
    const before = JSON.stringify(a.toJSON());
    expect(() => a.merge(new LoadTimeline(500))).toThrow(
      /baseWindowMs mismatch \(250 vs 500\)/,
    );
    expect(JSON.stringify(a.toJSON())).toBe(before); // no half-merged state
  });

  it("rejects merging a timeline into itself", () => {
    const a = new LoadTimeline(250);
    expect(() => a.merge(a)).toThrow(/cannot merge a timeline into itself/);
  });

  it("rejects an invalid observationCutoffMs before any state mutation", () => {
    const a = replay(new LoadTimeline(250), [{ at: 0, kind: "req", ms: 5, ok: true }]);
    const b = replay(new LoadTimeline(250), [{ at: 0, kind: "req", ms: 5, ok: true }]);
    const before = JSON.stringify(a.toJSON());
    for (const bad of [-1, NaN, Infinity]) {
      expect(() => a.merge(b, { observationCutoffMs: bad })).toThrow(
        /observationCutoffMs must be a non-negative finite number/,
      );
    }
    expect(JSON.stringify(a.toJSON())).toBe(before);
  });

  it("refuses a count overflow BEFORE any mutation, even when width alignment was pending", () => {
    // Same discipline as LoadHistogram.merge (histogram codex R13), but pre-simulated:
    // the histogram's own guard would only fire mid-fold, leaving `this` half-merged.
    const bigHist = (count: number) => ({
      v: 1,
      relativeError: 0.01,
      buckets: [[0, count]] as [number, number][],
      zeroCount: 0,
      count,
      sum: count,
      min: 1,
      max: 1,
    });
    const bigTimeline = (count: number, windowMs: number) =>
      LoadTimeline.fromJSON({
        v: 1,
        baseWindowMs: 250,
        windowMs,
        maxWindows: 600,
        windows: [
          [
            0,
            {
              requests: count,
              errors: 0,
              starts: 0,
              iterations: 0,
              endedUnknown: 0,
              peakLower: 1,
              peakUpper: 1,
              latency: bigHist(count),
            },
          ],
        ],
        fullContributors: 1,
        contributorCutoffsMs: [],
      });
    const a = bigTimeline(Number.MAX_SAFE_INTEGER - 1, 250);
    const b = bigTimeline(Number.MAX_SAFE_INTEGER - 1, 500); // coarser: a must coarsen first
    const before = JSON.stringify(a.toJSON());
    expect(() => a.merge(b)).toThrow(/exceeds MAX_SAFE_INTEGER/);
    // Field-for-field untouched — including windowMs: the width alignment never ran.
    expect(JSON.stringify(a.toJSON())).toBe(before);
    expect(a.toJSON().windowMs).toBe(250);
    // The bound itself is reachable: a merge landing exactly ON it succeeds.
    const c = bigTimeline(Number.MAX_SAFE_INTEGER - 1, 250);
    const one = replay(new LoadTimeline(250), [{ at: 0, kind: "req", ms: 1, ok: true }]);
    c.merge(one);
    expect(c.toJSON().windows[0][1].latency.count).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("refuses near-2^53 window counter / census sums BEFORE any mutation (codex R3)", () => {
    // The histogram-R13 pattern, applied to the fields the histogram guard does NOT
    // cover: window counters, peak upper bounds and fullContributors have no runtime
    // guard, so past 2^53 their sums silently leave the exact-integer domain and the
    // merged toJSON would be rejected by its own fromJSON. The preflight refuses first.
    const smallHist = () => {
      const h = new LoadHistogram();
      h.record(5);
      return h.toJSON();
    };
    const wireWith = (
      window: Record<string, unknown>,
      top: Record<string, unknown> = {},
    ): LoadTimeline =>
      LoadTimeline.fromJSON({
        v: 1,
        baseWindowMs: 1000,
        windowMs: 1000,
        maxWindows: 600,
        windows: [
          [
            0,
            {
              requests: 1,
              errors: 0,
              starts: 0,
              iterations: 0,
              endedUnknown: 0,
              peakLower: 0,
              peakUpper: 0,
              latency: smallHist(),
              ...window,
            },
          ],
        ],
        fullContributors: 1,
        contributorCutoffsMs: [],
        ...top,
      });
    const MSI = Number.MAX_SAFE_INTEGER;
    // One side at the bound, the other contributing 1 — refuse, both sides untouched.
    const a = wireWith({ requests: MSI });
    const b = wireWith({});
    const aBefore = JSON.stringify(a.toJSON());
    const bBefore = JSON.stringify(b.toJSON());
    expect(() => a.merge(b)).toThrow(/combined requests count .* exceeds MAX_SAFE_INTEGER/);
    expect(JSON.stringify(a.toJSON())).toBe(aBefore); // no half-merged state
    expect(JSON.stringify(b.toJSON())).toBe(bBefore);
    // Every unguarded summed field refuses the same way.
    expect(() => wireWith({ starts: MSI }).merge(wireWith({ starts: 1 }))).toThrow(
      /combined starts count .* exceeds MAX_SAFE_INTEGER/,
    );
    expect(() => wireWith({ iterations: MSI }).merge(wireWith({ iterations: 1 }))).toThrow(
      /combined iterations count .* exceeds MAX_SAFE_INTEGER/,
    );
    expect(() => wireWith({ peakUpper: MSI }).merge(wireWith({ peakUpper: 1 }))).toThrow(
      /combined peak in-flight upper bound .* exceeds MAX_SAFE_INTEGER/,
    );
    expect(() => wireWith({}, { fullContributors: MSI }).merge(wireWith({}))).toThrow(
      /combined fullContributors .* exceeds MAX_SAFE_INTEGER/,
    );
    // The bound itself is reachable: MSI−1 + 1 lands exactly ON it and succeeds.
    const c = wireWith({ requests: MSI - 1 });
    c.merge(wireWith({}));
    expect(c.toJSON().windows[0][1].requests).toBe(MSI);
    expect(LoadTimeline.fromJSON(c.toJSON()).finalize()).toEqual(c.finalize()); // still revivable
  });

  it("merged timelines round-trip through the wire form", () => {
    const a = replay(new LoadTimeline(1000), A_EVENTS);
    // A lost worker's snapshot: everything it recorded precedes its observedAt (2300);
    // its one start hangs in flight there, so the merge books censoring state.
    const bLost = replay(new LoadTimeline(1000), [
      { at: 200, kind: "start" },
      { at: 1400, kind: "req", ms: 20, ok: false },
    ]);
    a.merge(bLost, { observationCutoffMs: 2300 });
    const revived = LoadTimeline.fromJSON(JSON.parse(JSON.stringify(a)));
    expect(JSON.stringify(revived.toJSON())).toBe(JSON.stringify(a.toJSON()));
    expect(revived.finalize(5000)).toEqual(a.finalize(5000));
  });
});

describe("LoadTimeline censoring (lost-worker observation cutoff)", () => {
  // A healthy worker A with one long iteration; a lost worker B whose second iteration is
  // still in flight when observation stops at 2300ms. Without censoring B's hung start
  // ghost-carries concurrency forever; with it the carry drops at the cutoff window.
  const A_EVENTS: ReplayEvent[] = [
    { at: 100, kind: "start" },
    { at: 5800, kind: "end" },
  ];
  const B_EVENTS: ReplayEvent[] = [
    { at: 500, kind: "start" },
    { at: 600, kind: "start" },
    { at: 1200, kind: "end" }, // one of the two completes
    { at: 2100, kind: "req", ms: 10, ok: true }, // last observed activity
  ];
  const mkA = () => replay(new LoadTimeline(1000), A_EVENTS);
  const mkB = () => replay(new LoadTimeline(1000), B_EVENTS);

  it("an uncensored merge ghost-carries the lost worker's hung iteration (the problem)", () => {
    const a = mkA();
    a.merge(mkB());
    const windows = a.finalize(6000).windows;
    // B's hung start keeps the carry at 2 through the end of the run — a ghost.
    expect(windows[4].peakInFlight).toBe(2);
    expect(windows[5].peakInFlight).toBe(2);
  });

  it("censors at the cutoff: ended-unknown closes the deficit and no ghost carries forward", () => {
    const a = mkA();
    const b = mkB();
    const bBefore = JSON.stringify(b.toJSON());
    a.merge(b, { observationCutoffMs: 2300 });
    expect(JSON.stringify(b.toJSON())).toBe(bBefore); // the merged-in side is never mutated
    const windows = a.finalize(6000).windows;
    // The mid-window cutoff (2300, inside window 2 = [2000, 3000)) keeps its window
    // WHOLE: B's request at 2100 precedes the cutoff by construction and folds in.
    expect(windows[2].requests).toBe(1);
    // The cutoff window (2) closes B's in-flight start as ended-unknown: counted into
    // iterations, disclosed via endedUnknown.
    expect(windows[2].iterations).toBe(1);
    expect(windows[2].endedUnknown).toBe(1);
    expect(windows[2].contributorsPartial).toBeUndefined(); // B observed through its cutoff
    // After the cutoff only A's carry remains — no ghost concurrency.
    expect(windows[3].peakInFlight).toBe(1);
    expect(windows[4].peakInFlight).toBe(1);
    expect(windows[5].peakInFlight).toBe(1);
    // ... and those windows are marked partial: B did not observe them, so the bounds
    // cover the observed contributor only (not a global bound, §7.3).
    expect(windows[3].contributorsPartial).toBe(true);
    expect(windows[4].contributorsPartial).toBe(true);
    expect(windows[5].contributorsPartial).toBe(true);
    expect(windows[0].contributorsPartial).toBeUndefined();
    expect(windows[1].contributorsPartial).toBeUndefined();
    // While B was observed its concurrency is fully counted (both live at w1 entry: 1+2).
    expect(windows[1].peakInFlightBounds).toEqual({ lower: 3, upper: 3 });
    expect(windows[2].peakInFlightBounds).toEqual({ lower: 2, upper: 2 });
    // Compat scalar stays the upper bound everywhere.
    for (const w of windows) expect(w.peakInFlight).toBe(w.peakInFlightBounds!.upper);
    // Census on the wire: A full, B censored at 2300.
    expect(a.toJSON().fullContributors).toBe(1);
    expect(a.toJSON().contributorCutoffsMs).toEqual([2300]);
  });

  it("rejects a cutoff earlier than the snapshot's coverage, before any mutation (codex R2)", () => {
    // A real last-snapshot is serialized AT its observedAt and physically cannot contain
    // later events — recorded data past the cutoff window means the caller passed the
    // wrong cutoff, not that something needs dropping.
    const a = mkA();
    const b = mkB();
    b.recordRequest(4700, 30, false, 1); // observed later than the claimed cutoff
    const aBefore = JSON.stringify(a.toJSON());
    const bBefore = JSON.stringify(b.toJSON());
    expect(() => a.merge(b, { observationCutoffMs: 2300 })).toThrow(
      /predates the snapshot's observation coverage/,
    );
    expect(JSON.stringify(a.toJSON())).toBe(aBefore); // no half-merged state
    expect(JSON.stringify(b.toJSON())).toBe(bBefore); // the snapshot side is untouched too
    // Same guard through mergeAll, same atomicity (inputs never mutated).
    expect(() =>
      LoadTimeline.mergeAll([{ timeline: a }, { timeline: b, observationCutoffMs: 2300 }]),
    ).toThrow(/predates the snapshot's observation coverage/);
    expect(JSON.stringify(a.toJSON())).toBe(aBefore);
    expect(JSON.stringify(b.toJSON())).toBe(bBefore);
  });
});

describe("LoadTimeline.mergeAll", () => {
  const mk = (events: ReplayEvent[]) => replay(new LoadTimeline(1000), events);
  const A: ReplayEvent[] = [
    { at: 100, kind: "start" },
    { at: 5800, kind: "end" },
  ];
  const B: ReplayEvent[] = [
    { at: 500, kind: "start" },
    { at: 2100, kind: "req", ms: 10, ok: true },
  ];
  const C: ReplayEvent[] = [
    { at: 900, kind: "req", ms: 4, ok: false },
    { at: 1500, kind: "req", ms: 6, ok: true },
  ];

  it("one-shot fold ≡ sequential pairwise merges, inputs untouched", () => {
    const parts = [
      { timeline: mk(A) },
      { timeline: mk(B), observationCutoffMs: 2300 },
      { timeline: mk(C) },
    ];
    const snapshots = parts.map((p) => JSON.stringify(p.timeline.toJSON()));
    const folded = LoadTimeline.mergeAll(parts);
    const manual = LoadTimeline.fromJSON(mk(A).toJSON());
    manual.merge(mk(B), { observationCutoffMs: 2300 });
    manual.merge(mk(C));
    expect(JSON.stringify(folded.toJSON())).toBe(JSON.stringify(manual.toJSON()));
    expect(folded.finalize(6000)).toEqual(manual.finalize(6000));
    parts.forEach((p, i) => expect(JSON.stringify(p.timeline.toJSON())).toBe(snapshots[i]));
  });

  it("can censor the FIRST part (any worker can be the lost one)", () => {
    const folded = LoadTimeline.mergeAll([
      { timeline: mk(B), observationCutoffMs: 2300 }, // the lost worker leads the list
      { timeline: mk(A) },
    ]);
    const j = folded.toJSON();
    expect(j.fullContributors).toBe(1);
    expect(j.contributorCutoffsMs).toEqual([2300]);
    const windows = folded.finalize(6000).windows;
    expect(windows[2].endedUnknown).toBe(1); // B's hung start closed at its cutoff
    expect(windows[3].peakInFlight).toBe(1); // A's carry only — no ghost
    expect(windows[3].contributorsPartial).toBe(true);
  });

  it("is order-insensitive in the finalized output", () => {
    const ab = LoadTimeline.mergeAll([
      { timeline: mk(A) },
      { timeline: mk(B), observationCutoffMs: 2300 },
    ]);
    const ba = LoadTimeline.mergeAll([
      { timeline: mk(B), observationCutoffMs: 2300 },
      { timeline: mk(A) },
    ]);
    expect(ab.finalize(6000)).toEqual(ba.finalize(6000));
    expect(JSON.stringify(ab.toJSON())).toBe(JSON.stringify(ba.toJSON()));
  });

  it("is order-independent across all permutations of mixed-width parts (codex R1)", () => {
    // Three parts at three coarsening stages (250/500/1000ms — all base·2ⁿ over base 250),
    // one of them censored. Naive sequential folding coarsens the partially-merged state
    // when it meets a coarser part, folding already-merged bounds at a different
    // granularity per arrival order; the two-phase fold must give one result for all 6
    // orders — byte-identical wire form, field-identical finalize.
    const mkFine = () =>
      replay(new LoadTimeline(250, 600), [
        { at: 0, kind: "start" },
        { at: 300, kind: "req", ms: 10, ok: true },
        { at: 1100, kind: "end" },
      ]);
    const mkMid = () =>
      replay(new LoadTimeline(250, 6), [
        { at: 0, kind: "req", ms: 20, ok: true },
        { at: 200, kind: "start" }, // hangs — still in flight at the 1700 cutoff below
        { at: 1600, kind: "req", ms: 30, ok: false }, // pushes past the cap: coarsens to 500
      ]);
    const mkCoarse = () =>
      replay(new LoadTimeline(250, 4), [
        { at: 100, kind: "req", ms: 40, ok: true },
        { at: 500, kind: "start" },
        { at: 3300, kind: "req", ms: 50, ok: true }, // coarsens twice: to 1000
        { at: 3500, kind: "end" },
      ]);
    expect(mkFine().toJSON().windowMs).toBe(250);
    expect(mkMid().toJSON().windowMs).toBe(500);
    expect(mkCoarse().toJSON().windowMs).toBe(1000);
    const parts = () => [
      { timeline: mkFine() },
      { timeline: mkMid(), observationCutoffMs: 1700 }, // lost mid-run, one start in flight
      { timeline: mkCoarse() },
    ];
    const orders = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    const folds = orders.map((order) => {
      const ps = parts();
      const folded = LoadTimeline.mergeAll(order.map((i) => ps[i]));
      return { wire: JSON.stringify(folded.toJSON()), final: folded.finalize(4000) };
    });
    for (const f of folds.slice(1)) {
      expect(f.wire).toBe(folds[0].wire);
      expect(f.final).toEqual(folds[0].final);
    }
    // Sanity on the one shape they all share: coarsest width, min cap honored, nothing
    // lost, censoring landed.
    const shape = folds[0].final;
    expect(shape.windowMs).toBe(1000);
    expect(shape.windows.map((w) => w.requests)).toEqual([3, 1, 0, 1]);
    expect(shape.windows.reduce((s, w) => s + w.iterations, 0)).toBe(3);
    expect(shape.windows[1].endedUnknown).toBe(1);
    expect(shape.windows[2].contributorsPartial).toBe(true);
    expect(shape.windows.map((w) => w.peakInFlightBounds)).toEqual([
      { lower: 1, upper: 3 },
      { lower: 3, upper: 3 },
      { lower: 1, upper: 1 },
      { lower: 1, upper: 1 },
    ]);
  });

  it("a single part is an exact clone; an empty list throws", () => {
    const solo = mk(C);
    const folded = LoadTimeline.mergeAll([{ timeline: solo }]);
    expect(JSON.stringify(folded.toJSON())).toBe(JSON.stringify(solo.toJSON()));
    expect(folded.finalize(3000)).toEqual(solo.finalize(3000));
    expect(() => LoadTimeline.mergeAll([])).toThrow(/needs at least one part/);
  });
});
