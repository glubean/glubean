/**
 * Canonical Glubean kind / file-stem registry — the single source of truth for
 * which kinds exist and which filename stems map to them.
 *
 * Consumers (scanner walk, CLI target resolution, config validation, contract
 * extraction) derive their own suffix views from this registry. The *vocabulary*
 * (kinds + stems) lives here once; the *extension policy* stays per-consumer
 * (some recognize only `.ts`, others `.ts`/`.js`/`.mjs`) because those differ by
 * purpose, not by duplication.
 *
 * Adding a kind (e.g. `load`) means editing this registry + each consumer's
 * explicit opt-in flag, instead of hunting scattered string literals.
 */

/** Recognized source extensions for Glubean files. */
export const GLUBEAN_EXTENSIONS = [".ts", ".js", ".mjs"] as const;

/** Suite / runnable kinds (the values valid in `glubean.yaml` `kinds:`). */
export type GlubeanSuiteKind = "test" | "contract" | "flow";

/** File-classification kinds: suite kinds plus bootstrap overlay + load files.
 *  `load` is classified (and has suffixes) but is NOT a `kinds:` suite value —
 *  load plans run via the dedicated `glubean load` command over file/dir/glob
 *  targets, not through a `glubean.yaml` profile suite. */
export type GlubeanFileKind = GlubeanSuiteKind | "bootstrap" | "load";

interface GlubeanKindDef {
  kind: GlubeanFileKind;
  /** Filename stems mapping to this kind (e.g. flow → ["flow", "workflow"]). */
  stems: readonly string[];
  /** Eligible as a suite kind in `glubean.yaml` `kinds:`. */
  suiteKind: boolean;
  /** Safe to runtime-import for contract/workflow artifact extraction. */
  runtimeArtifact: boolean;
}

export const GLUBEAN_KINDS: readonly GlubeanKindDef[] = [
  { kind: "test", stems: ["test"], suiteKind: true, runtimeArtifact: false },
  { kind: "contract", stems: ["contract"], suiteKind: true, runtimeArtifact: true },
  // `.workflow` is the canonical vNext stem; `.flow` is the legacy alias. Both
  // ride the "flow" kind during the migration window.
  { kind: "flow", stems: ["flow", "workflow"], suiteKind: true, runtimeArtifact: true },
  // `.load.ts` performance plans. CLASSIFIED (stem + suffixes) but NOT a suite
  // kind: load runs via the dedicated `glubean load` command over file/dir/glob
  // targets, not a `glubean.yaml` profile suite — so it never validates as a
  // `kinds:` value it can't execute through `glubean run`. runtimeArtifact:false:
  // load uses its OWN discovery/exec path, not the contract/workflow eager-import
  // nor the test runner's discovery.
  { kind: "load", stems: ["load"], suiteKind: false, runtimeArtifact: false },
  // bootstrap files register contract overlays; not a runnable/suite kind, but
  // they must be eagerly loaded (hence runtimeArtifact).
  { kind: "bootstrap", stems: ["bootstrap"], suiteKind: false, runtimeArtifact: true },
];

/** Suite kinds valid in `glubean.yaml` `kinds:`. */
export const SUITE_KINDS: readonly GlubeanSuiteKind[] = GLUBEAN_KINDS.filter(
  (k) => k.suiteKind,
).map((k) => k.kind as GlubeanSuiteKind);

/** Build `.stem.ext` suffixes for the given stems × extensions. */
export function buildSuffixes(
  stems: readonly string[],
  exts: readonly string[] = GLUBEAN_EXTENSIONS,
): string[] {
  return stems.flatMap((stem) => exts.map((ext) => `.${stem}${ext}`));
}

/** All suffixes for one kind across the given extensions (default: all). */
export function suffixesForKind(
  kind: GlubeanFileKind,
  exts: readonly string[] = GLUBEAN_EXTENSIONS,
): string[] {
  const def = GLUBEAN_KINDS.find((k) => k.kind === kind);
  return def ? buildSuffixes(def.stems, exts) : [];
}

/** Classify a file path to its kind by stem (across the given extensions). */
export function classifyByStem(
  filePath: string,
  exts: readonly string[] = GLUBEAN_EXTENSIONS,
): GlubeanFileKind | undefined {
  for (const def of GLUBEAN_KINDS) {
    if (buildSuffixes(def.stems, exts).some((suffix) => filePath.endsWith(suffix))) {
      return def.kind;
    }
  }
  return undefined;
}
