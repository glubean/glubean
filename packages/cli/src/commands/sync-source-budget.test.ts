/**
 * codex R1 P2 — the verbatim `projection.sourceText` must never be what tips a
 * large project's contracts POST over the platform route's 8 MiB body cap into
 * a 413 that can't sync at all. `applySourceTextBudget` enforces (a) a
 * per-contract cap (an oversized span isn't reviewable source) and (b) a
 * largest-first total budget; structured projections are NEVER dropped.
 */
import { describe, expect, test } from "vitest";
import { applySourceTextBudget } from "./sync.js";

const contract = (sourceText: string | undefined, extra: Record<string, unknown> = {}) => ({
  projection: {
    id: "c",
    cases: [{ key: "ok" }],
    ...(sourceText !== undefined ? { sourceText } : {}),
    ...extra,
  },
});

describe("applySourceTextBudget", () => {
  test("no-op when everything fits", () => {
    const contracts = [contract("export const a = api(...);"), contract(undefined)];
    const omitted = applySourceTextBudget(contracts);
    expect(omitted).toBe(0);
    expect((contracts[0].projection as { sourceText?: string }).sourceText).toBeDefined();
  });

  test("drops a single source over the per-contract cap, keeps the projection", () => {
    const big = contract("x".repeat(100));
    const omitted = applySourceTextBudget([big], /* perContractMax */ 64);
    expect(omitted).toBe(1);
    const p = big.projection as { sourceText?: string; cases: unknown };
    expect(p.sourceText).toBeUndefined();
    // The structured projection survives — only the source extra is dropped.
    expect(p.cases).toBeDefined();
  });

  test("over-budget bodies drop EVERY source (all-or-nothing, no selective churn)", () => {
    const small = contract("s".repeat(50));
    const mid = contract("m".repeat(200));
    const large = contract("l".repeat(400));
    const contracts = [small, large, mid];
    // Budget sized so the body with sources exceeds it. All-or-nothing: a
    // SELECTIVE (largest-first) drop would let one contract's growth strip a
    // different, unchanged contract's source — appending a false Cloud revision
    // for it (the server hashes the whole projection). So crossing the budget
    // strips every source, and each contract's payload stays a function of
    // changes its author actually made.
    const base = Buffer.byteLength(
      JSON.stringify({ contracts: [contract(undefined), contract(undefined), contract(undefined)] }),
      "utf8",
    );
    const omitted = applySourceTextBudget(contracts, 10_000, base + 300);
    expect(omitted).toBe(3);
    for (const c of contracts) {
      expect((c.projection as { sourceText?: string }).sourceText).toBeUndefined();
    }
  });

  test("drops every source when even that is needed, never the projections", () => {
    const contracts = [contract("a".repeat(300)), contract("b".repeat(300))];
    const omitted = applySourceTextBudget(contracts, 10_000, 10);
    expect(omitted).toBe(2);
    for (const c of contracts) {
      const p = c.projection as { sourceText?: string; id: string };
      expect(p.sourceText).toBeUndefined();
      expect(p.id).toBe("c");
    }
  });

  test("multi-byte sources are measured in bytes, not code units", () => {
    // 40 chars × 3 bytes each = 120 bytes > 100-byte cap, though length 40 < 100.
    const cjk = contract("语".repeat(40));
    const omitted = applySourceTextBudget([cjk], 100);
    expect(omitted).toBe(1);
  });
});
