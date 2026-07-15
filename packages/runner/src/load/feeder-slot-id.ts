/**
 * Canonical FeederSlotId encoding (proposal §9) — the SINGLE SOURCE OF TRUTH for the
 * stable string identity of a run's feeder draw scopes, referenced by BOTH:
 *  - the orchestrator, which stamps it as a workload feeder's `slotKey` (the keyed-RNG
 *    stream key + draw-scope identity, `orchestrator.ts` `makeWorkload`); and
 *  - `shardPlan`, which keys each shard's per-feeder row segment by it
 *    (`shard.ts` `enumerateFeederSlots` → `LoadShard.feederSegments`).
 *
 * Both sides MUST produce byte-identical strings or a shard would draw from the wrong
 * segment (D1-1 originally inlined this construction in both places with a "keep in sync"
 * comment — this module removes that drift risk by making them call one function).
 *
 * The encoding is a JSON array tuple (`["shared", name]` / `["entry", entryId, name]`),
 * injective by construction — the same mechanism the keyed-RNG key encoding uses, and
 * (per §9, D0-6) the collision-safe replacement for the URL-escape scheme the proposal
 * originally sketched. It corresponds to the orchestrator's `counterKey` draw scope.
 */

/** Canonical id of a SHARED (top-level) feeder slot — one run-global draw sequence per
 *  name, drawn by every mix entry that does not override the name (and by every
 *  single-scenario feeder). */
export function sharedFeederSlotId(name: string): string {
  return JSON.stringify(["shared", name]);
}

/** Canonical id of a per-ENTRY feeder slot — a traffic-mix entry's own feeder (the entry
 *  wins a name clash with a shared feeder). `entryId` is the entry's `id` (`""` when an
 *  entry declared none), so two entries reusing one binding stay distinct slots. */
export function entryFeederSlotId(entryId: string, name: string): string {
  return JSON.stringify(["entry", entryId, name]);
}
