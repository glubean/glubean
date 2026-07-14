import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { feeder, type FeederDrawContext } from "./index.js";

// In-memory allocation tests — no HTTP. File-source tests use local temp files.
const ctx = (over: Partial<FeederDrawContext> = {}): FeederDrawContext => ({
  producerSlot: 0,
  producerCount: 1,
  slotIteration: 0,
  globalIteration: 0,
  ...over,
});

describe("feeder allocation", () => {
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("uniquePerVu gives one row per slot and fails when exhausted", () => {
    const f = feeder.fromArray(rows, { key: "id" }).uniquePerVu();
    expect(f.strategy).toBe("uniquePerVu");
    expect(f.exhausted).toBe("fail");
    expect(f.size).toBe(3);
    expect(f.allocate(ctx({ producerSlot: 0 }))).toEqual({ outcome: "value", value: rows[0], key: "a" });
    expect(f.allocate(ctx({ producerSlot: 2 }))).toEqual({ outcome: "value", value: rows[2], key: "c" });
    expect(f.allocate(ctx({ producerSlot: 3 }))).toEqual({ outcome: "exhausted" });
  });

  it("uniquePerIteration draws a fresh row per global iteration", () => {
    const f = feeder.fromArray(rows).uniquePerIteration();
    expect(f.allocate(ctx({ globalIteration: 1 }))).toEqual({ outcome: "value", value: rows[1] });
    expect(f.allocate(ctx({ globalIteration: 3 }))).toEqual({ outcome: "exhausted" });
  });

  it("roundRobin recycles by default", () => {
    const f = feeder.fromArray(rows).roundRobin();
    expect(f.exhausted).toBe("recycle");
    expect(f.allocate(ctx({ globalIteration: 4 }))).toEqual({ outcome: "value", value: rows[1] }); // 4 % 3
  });

  it("random returns an in-range row", () => {
    const f = feeder.fromArray(rows).random();
    const draw = f.allocate(ctx());
    expect(draw.outcome).toBe("value");
    if (draw.outcome === "value") expect(rows).toContain(draw.value);
  });

  it("weightedRandom only picks rows with positive weight", () => {
    const wrows = [
      { id: "x", w: 0 },
      { id: "y", w: 1 },
      { id: "z", w: 0 },
    ];
    const f = feeder.fromArray(wrows).weightedRandom({ weight: "w" });
    for (let i = 0; i < 25; i++) {
      const draw = f.allocate(ctx());
      expect(draw.outcome).toBe("value");
      if (draw.outcome === "value") expect(draw.value.id).toBe("y");
    }
  });

  it("weightedRandom with no positive weight is exhausted", () => {
    const f = feeder.fromArray([{ id: "x", w: 0 }]).weightedRandom({ weight: "w" });
    expect(f.allocate(ctx()).outcome).toBe("exhausted");
  });

  it("partitionByVu shards rows across slots", () => {
    const six = [0, 1, 2, 3, 4, 5].map((n) => ({ n }));
    const f = feeder.fromArray(six).partitionByVu();
    // producerCount 2 → slot 0 owns {0,2,4}, slot 1 owns {1,3,5}
    expect(f.allocate(ctx({ producerCount: 2, producerSlot: 0, slotIteration: 0 }))).toEqual({
      outcome: "value",
      value: { n: 0 },
    });
    expect(f.allocate(ctx({ producerCount: 2, producerSlot: 0, slotIteration: 1 }))).toEqual({
      outcome: "value",
      value: { n: 2 },
    });
    expect(f.allocate(ctx({ producerCount: 2, producerSlot: 1, slotIteration: 0 }))).toEqual({
      outcome: "value",
      value: { n: 1 },
    });
    // slot 0 partition has 3 rows; slotIteration 3 is out of range → fail
    expect(f.allocate(ctx({ producerCount: 2, producerSlot: 0, slotIteration: 3 })).outcome).toBe(
      "exhausted",
    );
  });

  it("skip and wait exhaustion policies surface distinct outcomes", () => {
    const skip = feeder.fromArray(rows).uniquePerVu({ exhausted: "skip" });
    expect(skip.allocate(ctx({ producerSlot: 9 }))).toEqual({ outcome: "skip" });
    const wait = feeder.fromArray(rows).uniquePerVu({ exhausted: "wait" });
    expect(wait.allocate(ctx({ producerSlot: 9 }))).toEqual({ outcome: "wait" });
  });

  it("an empty source is always exhausted", () => {
    const f = feeder.fromArray<{ id: string }>([]).roundRobin();
    expect(f.size).toBe(0);
    expect(f.allocate(ctx()).outcome).toBe("exhausted");
  });

  // The keyed RNG stream (ctx.rng): random/weightedRandom must be a pure function of
  // the draw context — counter-style, no internal state — so a load runtime that binds
  // rng to (seed, feeder slot, iteration index) gets reproducible draws.
  describe("ctx.rng (keyed random stream)", () => {
    afterEach(() => vi.restoreAllMocks());

    it("random draws via ctx.rng, statelessly: the same ctx repeats the same row", () => {
      const f = feeder.fromArray(rows, { key: "id" }).random();
      const c = ctx({ rng: () => 0.5 }); // floor(0.5 * 3) = row 1
      const first = f.allocate(c);
      expect(first).toEqual({ outcome: "value", value: rows[1], key: "b" });
      expect(f.allocate(c)).toEqual(first); // no internal state — same ctx, same draw
      expect(f.allocate(ctx({ rng: () => 0.9 }))).toEqual({ outcome: "value", value: rows[2], key: "c" }); // different keyed value → different row
    });

    it("weightedRandom draws via ctx.rng, statelessly", () => {
      const wrows = [
        { id: "light", w: 1 },
        { id: "heavy", w: 3 },
      ];
      const f = feeder.fromArray(wrows, { key: "id" }).weightedRandom({ weight: "w" });
      // total weight 4: rng 0.1 → r=0.4 lands in light's [0,1); rng 0.5 → r=2 in heavy's [1,4).
      const light = ctx({ rng: () => 0.1 });
      const heavy = ctx({ rng: () => 0.5 });
      expect(f.allocate(light)).toEqual({ outcome: "value", value: wrows[0], key: "light" });
      expect(f.allocate(heavy)).toEqual({ outcome: "value", value: wrows[1], key: "heavy" });
      expect(f.allocate(heavy)).toEqual(f.allocate(heavy)); // stateless repeat
    });

    it("falls back to Math.random when ctx.rng is absent (standalone SDK use)", () => {
      const spy = vi.spyOn(Math, "random").mockReturnValue(0);
      const f = feeder.fromArray(rows, { key: "id" }).random();
      expect(f.allocate(ctx())).toEqual({ outcome: "value", value: rows[0], key: "a" });
      expect(spy).toHaveBeenCalledTimes(1);
      // With ctx.rng present, Math.random is NOT consulted.
      spy.mockClear();
      f.allocate(ctx({ rng: () => 0.5 }));
      expect(spy).not.toHaveBeenCalled();
    });
  });

  it("fromJson loads rows from a file and wraps them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "feeder-"));
    const file = join(dir, "products.json");
    writeFileSync(file, JSON.stringify([{ sku: "A" }, { sku: "B" }]));
    const src = await feeder.fromJson<{ sku: string }>(file, { key: "sku" });
    expect(src.rows).toHaveLength(2);
    expect(src.roundRobin().allocate(ctx({ globalIteration: 1 }))).toEqual({
      outcome: "value",
      value: { sku: "B" },
      key: "B",
    });
  });
});
