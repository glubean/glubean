import { describe, it, expect } from "vitest";

import { LoadTimeline } from "./timeline.js";

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
});
