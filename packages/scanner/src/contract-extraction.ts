/**
 * Runtime contract extraction — dynamically imports .contract.ts modules
 * and extracts metadata from exported contract objects.
 *
 * Scanner is duck-typing-only (no @glubean/sdk dependency). We recognize
 * shapes without importing types.
 *
 * Output:
 *   - NormalizedContractMeta — JSON-safe contract projection (mirrors
 *     ExtractedContractProjection from sdk, plus `exportName`)
 *     ExtractedFlowProjection, plus `exportName`)
 *
 * Schema conversion: anywhere scanner sees a value with `.toJSONSchema()`
 * it invokes that method. This handles Zod schemas embedded inside
 * adapter-defined `schemas` opaque blobs without knowing the protocol.
 */

import { pathToFileURL } from "node:url";
import { resolve, relative, basename } from "node:path";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { GLUBEAN_KINDS, buildSuffixes } from "./kinds.js";
import { extractContractCases } from "./extractor-ast.js";

// =============================================================================
// Types — mirror sdk's ExtractedContractProjection / ExtractedFlowProjection
// =============================================================================

/** Case lifecycle. */
export type CaseLifecycle = "active" | "deferred" | "deprecated";

/** Case severity. */
export type CaseSeverity = "critical" | "warning" | "info";

/** Case execution requirement. */
export type CaseRequires = "headless" | "browser" | "out-of-band";

/** Case default run policy. */
export type CaseDefaultRun = "always" | "opt-in";

/** Projectable description of opaque verify() semantics. */
export type VerifyRule =
  | string
  | {
      id?: string;
      description: string;
      severity?: CaseSeverity;
      extensions?: Record<string, unknown>;
    };

/** Runnability gates mirrored from the SDK's CaseRunnability. */
export interface NormalizedRunnability {
  requireAttachment?: boolean;
  requireSession?: boolean;
}

/** A named example entry for OpenAPI docs. */
export interface NormalizedExample {
  value: unknown;
  summary?: string;
  description?: string;
}

/** Per-parameter metadata for OpenAPI output. */
export interface NormalizedParamMeta {
  schema?: unknown | null;
  description?: string;
  required?: boolean;
  deprecated?: boolean;
}

/**
 * Protocol-agnostic case metadata. Mirrors sdk's `ExtractedCaseMeta`.
 * `schemas` and `meta` are adapter-defined JSON-safe blobs; scanner treats
 * them as opaque but converts any embedded `.toJSONSchema()` methods.
 */
export interface NormalizedCaseMeta {
  key: string;
  description?: string;
  lifecycle: CaseLifecycle;
  severity: CaseSeverity;
  deferredReason?: string;
  deprecatedReason?: string;
  requires?: CaseRequires;
  defaultRun?: CaseDefaultRun;
  tags?: string[];
  extensions?: Record<string, unknown>;
  /** Adapter-defined payload shape (opaque to scanner). */
  schemas?: unknown;
  /** Adapter-defined free-form meta (opaque). */
  meta?: unknown;
  /**
   * World-state precondition — attachment-model §0.9. Adapter threads
   * through from `BaseCaseSpec.given`. Not a contract semantic input,
   * but projected because it changes what `expect` means.
   */
  given?: string;
  /** True when executable semantics also live in an adapter verify() callback. */
  hasVerify?: boolean;
  /** Projectable companion rules for opaque verify() callbacks. */
  verifyRules?: VerifyRule[];
  /**
   * Runnability metadata — attachment-model §7.2. `requireAttachment`
   * blocks raw execution (case MUST run via a bootstrap overlay). Lives
   * as a first-class field, not in `extensions`, per proposal.
   */
  runnability?: NormalizedRunnability;
  /**
   * True iff the case declared `needs`. Authoritative trigger for
   * `rawBypass` in the attachment inventory. Decoupled from `needsSchema`:
   * a case can have needs whose schema isn't projectable.
   */
  hasNeeds?: boolean;
  /**
   * v10 attachment-model — JSON-safe `needs` schema. May be undefined
   * even when `hasNeeds` is true (e.g. opaque custom validator). Use
   * `hasNeeds` for inventory/rawBypass decisions; this field is a
   * decoration for consumers that want the schema shape when available.
   */
  needsSchema?: unknown;
  /**
   * "inbound" = the counterparty calls us (inbound-contract-design §9.2).
   * Absent = outbound. Inbound cases are never runnable — consumers
   * enumerating executable cases must skip them (see `runnable`).
   */
  direction?: "inbound";
  /**
   * `false` = the case registers no Test / runnable-inventory entry
   * (design §9.5); it exists in contract metadata only. Absent = runnable.
   */
  runnable?: boolean;
  /**
   * GLU-221 phase 1 — best-effort source location of this case's key in the
   * declaring file, project-root-relative. Populated ONLY when the contract
   * uses the literal `contract.<protocol>("id", { cases: {...} })` form (the
   * same narrow form `extractContractCases` recognizes) — a scoped/custom
   * factory (`contract.http.with(...)`, a wrapped `stableApi(...)`) is
   * invisible to static analysis and leaves this undefined, never fabricated.
   * 1-based. No `column` — extractor-ast.ts hardcodes col 1 for exports
   * elsewhere in this codebase, so a column here would be equally fake.
   */
  sourceFile?: string;
  /** 1-based start line of the case key, when statically resolvable. */
  line?: number;
  /** 1-based end line of the case's declaring object, when resolvable. */
  endLine?: number;
}

/**
 * Protocol-agnostic contract metadata. Mirrors `ExtractedContractProjection`.
 */
export interface NormalizedContractMeta {
  id: string;
  exportName: string;
  protocol: string;
  /** Protocol-agnostic target (HTTP: "POST /users"). */
  target: string;
  description?: string;
  feature?: string;
  instanceName?: string;
  tags?: string[];
  deprecated?: string;
  extensions?: Record<string, unknown>;
  schemas?: unknown;
  meta?: unknown;
  cases: NormalizedCaseMeta[];
  /**
   * Fully-qualified logical paths of schemas DECLARED but not projectable
   * (the adapter's `schemaToJsonSchema` couldn't convert them). Mirrors
   * `ExtractedContractProjection.unprojectableSchemas`. The schema VALUE is
   * `undefined` in the projection either way; this list lets a snapshot tell
   * "couldn't project" apart from "no schema" and derive `projectionComplete`.
   * Omitted when every declared schema projected cleanly.
   */
  unprojectableSchemas?: string[];
  /**
   * GLU-221 phase 1 — best-effort source location of the contract's export
   * statement, project-root-relative (relative to the directory `scan()`/
   * `extractContractFromFile()` was invoked with). Same narrow-form caveat
   * as `NormalizedCaseMeta.sourceFile`: only literal `contract.<protocol>(...)`
   * exports are statically visible; scoped/custom factories leave this
   * undefined rather than a fabricated guess. No `column` (see case-level doc).
   */
  sourceFile?: string;
  /** 1-based start line of the export statement, when statically resolvable. */
  line?: number;
  /** 1-based end line of the export statement, when resolvable. */
  endLine?: number;
}

/**
 * @deprecated Alias for NormalizedContractMeta. Use directly.
 */
export type ExtractedContract = NormalizedContractMeta;

// --- Flow --------------------------------------------------------------------

/**
 * Single step in a flow projection. Discriminated by `kind`.
 */
/**
 * JSON-safe predicate descriptor (scanner-side mirror of the SDK's
 * `ExtractedPredicate` — scanner is dep-free, shape duplicated structurally).
 */
export type NormalizedPredicate =
  | {
      kind: "compare";
      op: string;
      path: string[];
      /** scalar compare — absent on the path-vs-path form (phase4 §7). */
      value?: string | number | boolean | null;
      /** path-vs-path compare (eq/ne): the rhs state path. */
      rhsPath?: string[];
    }
  | { kind: "in"; path: string[]; values: Array<string | number | boolean | null> }
  | { kind: "presence"; op: string; path: string[] }
  | { kind: "matches"; path: string[]; pattern: string; flags?: string }
  | { kind: "and" | "or"; clauses: NormalizedPredicate[] }
  | { kind: "not"; clause: NormalizedPredicate }
  | { kind: "opaque"; strictness: "L1" | "L0"; mayDoAsyncIO: boolean };

/** One projected workflow node (scanner-side mirror of ProjectedWorkflowNode). */
export interface NormalizedWorkflowNode {
  kind: string;
  id: string;
  name?: string;
  description?: string;
  tags?: string[];
  extensions?: Record<string, unknown>;
  /** Static floor grade; the runtime may promote `opaque` → `trace`. */
  grade: "full" | "partial" | "opaque";
  /** contract-call / poll: protocol target + identity. */
  target?: string;
  protocol?: string;
  contractId?: string;
  caseKey?: string;
  accept?: Array<string | number>;
  /** action/compute dataflow hints. */
  reads?: string[];
  writes?: string[];
  asserts?: string;
  note?: string;
  /** group children. */
  nodes?: NormalizedWorkflowNode[];
  /** branch family (addendum §9): decision mode + projected case table. */
  mode?: "predicate" | "value";
  cases?: Array<{
    label?: string;
    value?: string | number | boolean | null;
    when?: NormalizedPredicate;
    nodes: NormalizedWorkflowNode[];
  }>;
  /** branch family: fallback nodes (branch else / switch identity / route default). */
  default?: NormalizedWorkflowNode[];
  /** route: terminal — no trunk continues after the taken case. */
  terminal?: boolean;
  message?: string;
  /** branch (value mode, S2.18): extracted selector path of `on`. */
  onPath?: string[];
  /** branch family (S2.18): present (always "identity") when no default
   * subtree is declared — explicit pass-through, not "unknown". */
  defaultBehavior?: "identity";
  /** poll: exit predicate + bounds. ABSENT on inbound polls (see `inbound`). */
  until?: NormalizedPredicate;
  /** poll (inbound, inbound-contract-design §9.3): the await declaration —
   * gated lens paths + the case's `within` promise. Presence = inbound. */
  inbound?: {
    viaPath: string[];
    correlate?: { eventPath: string[]; statePath: string[] };
    withinMs?: number;
  };
  every?: number;
  backoff?: number;
  timeoutMs?: number;
  perAttemptTimeoutMs?: number;
  maxAttempts?: number;
  /** call/action: explicit-intent retry. */
  retry?: { attempts: number; delay?: number; reason: string };
  /** check (declarative form): extracted L2 predicates — assertions as data. */
  expects?: unknown[];
  /** call/action/check: per-node terminal timeout (§17 #4). */
  nodeTimeoutMs?: number;
  /**
   * GLU-221 phase 1 — reserved for a future per-node source location.
   * NOT populated yet: workflow nodes are built via chained builder calls at
   * runtime (`workflow(...).call(...).action(...)...`), and — unlike a
   * `contract.<protocol>(...)` export — nothing in this codebase captures a
   * source position per builder call today. Declared now (optional, so
   * absence is indistinguishable from today's behavior) so the wire shape is
   * ready once a population mechanism exists; do not synthesize a value.
   */
  sourceFile?: string;
  /** See `sourceFile` — reserved, not populated in phase 1. */
  line?: number;
  /** See `sourceFile` — reserved, not populated in phase 1. */
  endLine?: number;
}

/** Workflow projection as carried in metadata.json (mirror of WorkflowProjection). */
export interface NormalizedWorkflowMeta {
  id: string;
  /** Data-driven member (workflow.each/pick): the un-interpolated template id.
   * Rows share ONE projected structure — only id/name/tags vary. */
  templateId?: string;
  /** Trace-grouping id (parallel matrices). */
  groupId?: string;
  /** Lifecycle visibility (phase4 §6): presence ⟺ the phase is declared;
   * note is the author's natural-language hint. Not a node — no grade. */
  setup?: { note?: string; timeoutMs?: number };
  teardown?: { note?: string; timeoutMs?: number };
  /** Members of this group may run in parallel. */
  parallel?: boolean;
  exportName: string;
  name?: string;
  description?: string;
  tags?: string[];
  /** Skip reason — discoverable so scanner/Cloud honor a deferred workflow. */
  skip?: string;
  only?: boolean;
  extensions?: Record<string, unknown>;
  nodes: NormalizedWorkflowNode[];
  /** Count of node static grades (workflow-level rollup, proposal §7.2). */
  gradeSummary: Record<"full" | "partial" | "opaque", number>;
}

// =============================================================================
// v10 attachment-model — runnable inventory (§7.2 / §7.3)
//
// Each entry in `attachments[]` represents one runnable test id. Discriminated
// by `kind`:
//
// - `raw` — a contract case with no bootstrap overlay (default).
// - `bootstrap-overlay` — a `contract.bootstrap(ref, spec)` registered for
//   the case. REPLACES the raw entry with the same testId. Carries
//   `rawBypass` when the case declares `needs` (explicit-input mode is
//   still discoverable per §5.1 algorithm).
// - `flow` — a `contract.flow(...).build()` orchestration. Independent
//   testId (no underlying case to replace).
//
// `testId` uniqueness within `attachments[]` is enforced; duplicate
// overlays for the same testId surface as load-time errors in
// `ExtractionResult.errors`.
// =============================================================================

/**
 * Default execution mode for a contract case — runs the case directly with
 * an explicit input (or void when no needs declared). Lives in
 * `attachments[]` until a bootstrap overlay replaces it.
 */
export interface NormalizedRawAttachment {
  kind: "raw";
  /** Contract case test id (`${contractId}.${caseKey}`). */
  testId: string;
  contractId: string;
  caseKey: string;
  /** Export name of the contract this case belongs to. */
  exportName: string;
  /** Runnability gates declared by the case. */
  runnability?: NormalizedRunnability;
}

/**
 * Bootstrap overlay attachment — `contract.bootstrap(ref, spec)` registers
 * a setup-and-cleanup that wraps the case. Replaces the raw entry for the
 * target testId. Body of `run`/`spec` is opaque per attachment-model §4.2.
 *
 * `paramsSchema` is undefined in v0 — structured-form param schema
 * extraction needs the bootstrap registry, deferred to Spike 3.
 *
 * `rawBypass` exposes the explicit-input execution path (§5.1) so the
 * inventory is the single authoritative source for both modes per testId.
 */
export interface NormalizedBootstrapOverlayAttachment {
  kind: "bootstrap-overlay";
  testId: string;
  /** The overlay's own export name (NOT the contract's). */
  exportName: string;
  targetRef: { contractId: string; caseKey: string };
  bootstrap: {
    /** v0: undefined; populated when structured-form `params` schema lands. */
    paramsSchema?: unknown;
  };
  /** Present iff the target case has `needs` (explicit-input bypass available). */
  rawBypass?: {
    available: true;
    /** JSON-safe form of the case's `needs` schema (may be undefined when SDK can't convert). */
    needsSchema: unknown;
  };
}

/** Discriminated attachment entry. One per testId in the inventory. */
export type NormalizedAttachmentMeta =
  | NormalizedRawAttachment
  | NormalizedBootstrapOverlayAttachment;

/** Result of extracting contracts/attachments from one or more files. */
export interface ExtractionResult {
  contracts: NormalizedContractMeta[];
  /**
   * Attachment inventory per attachment-model §7.3. Always present
   * (may be empty).
   */
  attachments: NormalizedAttachmentMeta[];
  /**
   * vNext workflow projections (S2.6) — read off `BuiltWorkflow._projection`.
   * A first-class top-level array (NOT an attachment kind: workflows are not
   * contract attachments; the attachment model stays contract-scoped).
   */
  workflows: NormalizedWorkflowMeta[];
  errors: Array<{ file: string; error: string }>;
}

// =============================================================================
// Duck typing
// =============================================================================

/**
 * Check if a value looks like a BootstrapAttachment (v10 attachment model).
 *
 * BootstrapAttachment is the runtime marker returned by `contract.bootstrap()`.
 * Carries `__glubean_type: "bootstrap-attachment"` and `testId`
 * (= `${contractId}.${caseKey}`). Scanner identifies attachments via this
 * marker without importing @glubean/sdk types.
 *
 * v0 attachment projection only surfaces metadata (kind, testId,
 * contractId, caseKey). Bootstrap params schema (structured-form `params`)
 * is not yet exposed on the export object — extracting it requires reading
 * the bootstrap registry, deferred to Spike 3 when the runner input
 * channel ships.
 */
export function isBootstrapAttachment(val: unknown): val is {
  __glubean_type: "bootstrap-attachment";
  testId: string;
} {
  return (
    typeof val === "object" &&
    val !== null &&
    (val as Record<string, unknown>).__glubean_type === "bootstrap-attachment" &&
    typeof (val as Record<string, unknown>).testId === "string"
  );
}

/**
 * Check if a value looks like a ProtocolContract.
 * ProtocolContract extends Array<Test> and has `_projection` with protocol + target.
 * (HTTP contracts now go through the same shape since the rewrite.)
 */
export function isProtocolContract(val: unknown): val is {
  _projection: {
    id?: string;
    protocol: string;
    target: string;
    description?: string;
    feature?: string;
    instanceName?: string;
    tags?: string[];
    deprecated?: string;
    extensions?: Record<string, unknown>;
    schemas?: unknown;
    meta?: unknown;
    cases: Array<{
      key: string;
      description?: string;
      lifecycle: string;
      severity: string;
      deferredReason?: string;
      deprecatedReason?: string;
      requires?: string;
      defaultRun?: string;
      tags?: string[];
      extensions?: Record<string, unknown>;
      schemas?: unknown;
      meta?: unknown;
    }>;
  };
  // `_extracted` is always populated by the SDK dispatcher
  // (adapter.normalize output). Scanner reads it as the JSON-safe form.
  _extracted: Record<string, unknown>;
} {
  return (
    Array.isArray(val) &&
    typeof (val as any)._projection === "object" &&
    (val as any)._projection !== null &&
    typeof (val as any)._projection.protocol === "string" &&
    typeof (val as any)._projection.target === "string" &&
    (val as any)._projection.protocol !== "flow" &&
    typeof (val as any)._extracted === "object" &&
    (val as any)._extracted !== null
  );
}

/**
 * If the export is an un-built vNext `WorkflowBuilder` (user omitted the
 * trailing `.build()`), call `.build()` to resolve it to a `BuiltWorkflow`.
 * Duck-typed like the flow builder; a build() that throws (poisoned builder)
 * leaves the value unrecognized — the import error surface is the SDK's.
 */
function autoBuildWorkflowBuilder(val: unknown): unknown {
  if (
    typeof val === "object" &&
    val !== null &&
    (val as any).__glubean_type === "workflow-builder" &&
    typeof (val as any).build === "function"
  ) {
    try {
      return (val as { build(): unknown }).build();
    } catch {
      return val;
    }
  }
  return val;
}

/**
 * Type guard — a built vNext workflow handle (`workflow(...).build()`):
 * a Test[] array carrying the workflow IR + the pre-computed `_projection`
 * (the same dual shape as FlowContract, recognized the same dep-free way).
 */
export function isBuiltWorkflow(val: unknown): val is {
  __glubean_type: "workflow";
  _projection: Omit<NormalizedWorkflowMeta, "exportName">;
} {
  return (
    Array.isArray(val) &&
    (val as any).__glubean_type === "workflow" &&
    typeof (val as any)._projection === "object" &&
    (val as any)._projection !== null &&
    typeof (val as any)._projection.id === "string"
  );
}

// =============================================================================
// File-level extraction
// =============================================================================

/**
 * Bootstrap overlay marker collected during file walk — pre-synthesis raw
 * material. Not yet a final attachment entry; `synthesizeAttachments`
 * decides whether to keep it (replaces a raw entry) or report duplicate.
 */
export interface BootstrapOverlayMarker {
  exportName: string;
  testId: string;
  contractId: string;
  caseKey: string;
}

//
// Reads the adapter-produced `_extracted` (JSON-safe form). The SDK's
// `dispatchContract` populates this field unconditionally by calling
// `adapter.normalize(_projection)` at construction time. Adapter is the
// authoritative source of protocol-specific normalization (which fields
// are schemas vs literal examples vs protocol metadata that must survive).
// =============================================================================

export function protocolContractToNormalized(
  value: { _projection: any; _extracted: any },
  exportName: string,
): NormalizedContractMeta {
  const ex = value._extracted;
  return {
    id: ex.id ?? exportName,
    exportName,
    protocol: ex.protocol,
    target: ex.target,
    description: ex.description,
    feature: ex.feature,
    instanceName: ex.instanceName,
    tags: ex.tags,
    deprecated: ex.deprecated,
    extensions: ex.extensions,
    schemas: ex.schemas,
    meta: ex.meta,
    ...(Array.isArray(ex.unprojectableSchemas) && ex.unprojectableSchemas.length > 0
      ? { unprojectableSchemas: ex.unprojectableSchemas }
      : {}),
    cases: (ex.cases ?? []).map((c: any): NormalizedCaseMeta => ({
      key: c.key,
      description: c.description,
      lifecycle: (c.lifecycle as CaseLifecycle) ?? "active",
      severity: (c.severity as CaseSeverity) ?? "warning",
      deferredReason: c.deferredReason,
      deprecatedReason: c.deprecatedReason,
      requires: c.requires as CaseRequires | undefined,
      defaultRun: c.defaultRun as CaseDefaultRun | undefined,
      tags: c.tags,
      extensions: c.extensions,
      schemas: c.schemas,
      meta: c.meta,
      given: c.given,
      hasVerify: c.hasVerify,
      verifyRules: c.verifyRules,
      runnability: c.runnability,
      hasNeeds: c.hasNeeds,
      needsSchema: c.needsSchema,
      direction: c.direction,
      runnable: c.runnable,
    })),
  };
}


/**
 * Convert a BootstrapAttachment runtime export to a marker. Splits
 * `testId` into contractId + caseKey at the LAST dot (contractId can have
 * dots, e.g. `v2.orders.create.success`). Returns null for malformed shapes
 * (no dot, leading dot, trailing dot) — caller skips them.
 */
export function bootstrapAttachmentToNormalized(
  attachment: { testId: string },
  exportName: string,
): BootstrapOverlayMarker | null {
  const dotIndex = attachment.testId.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === attachment.testId.length - 1) {
    return null;
  }
  const contractId = attachment.testId.slice(0, dotIndex);
  const caseKey = attachment.testId.slice(dotIndex + 1);
  return {
    exportName,
    testId: attachment.testId,
    contractId,
    caseKey,
  };
}

function normalizeRunnability(
  runnability: NormalizedRunnability | undefined,
): NormalizedRunnability | undefined {
  if (!runnability) return undefined;
  const normalized: NormalizedRunnability = {};
  if (runnability.requireAttachment !== undefined) {
    normalized.requireAttachment = runnability.requireAttachment;
  }
  if (runnability.requireSession !== undefined) {
    normalized.requireSession = runnability.requireSession;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

/**
 * Synthesize the §7.3 attachment inventory from raw materials.
 *
 * Algorithm (per attachment-model §7.3):
 *  1. Seed: each contract case → `kind: "raw"` entry (testId = `${id}.${key}`).
 *  2. Apply overlays: each marker → REPLACE the raw entry with the same
 *     testId by a `kind: "bootstrap-overlay"` entry. Carry `rawBypass`
 *     when the target case has `needsSchema` (explicit-input bypass
 *     available per §5.1).
 *  3. Duplicate detection: two markers with the same testId → push a
 *     load-time error. Keep the first; subsequent overlays ignored.
 *
 * Overlays whose testId doesn't match any contract case stand alone —
 * we still emit them as `bootstrap-overlay` (no `rawBypass`, no targetRef
 * verification). This keeps cross-file overlay registration discoverable
 * even when the contract module hasn't been scanned yet.
 */
export function synthesizeAttachments(
  contracts: NormalizedContractMeta[],
  markers: BootstrapOverlayMarker[],
): { attachments: NormalizedAttachmentMeta[]; errors: ExtractionResult["errors"] } {
  const errors: ExtractionResult["errors"] = [];

  // Index cases by testId for O(1) lookup during overlay application.
  const caseByTestId = new Map<
    string,
    { contract: NormalizedContractMeta; case: NormalizedCaseMeta }
  >();
  for (const contract of contracts) {
    for (const c of contract.cases) {
      caseByTestId.set(`${contract.id}.${c.key}`, { contract, case: c });
    }
  }

  // Step 1: seed raw entries. Reads `runnability` directly from the case
  // projection (post-Phase-2f-fix: the adapter now threads it as a
  // first-class field, no longer hidden under `extensions`).
  const byTestId = new Map<string, NormalizedAttachmentMeta>();
  for (const [testId, { contract, case: c }] of caseByTestId) {
    // Non-runnable cases (direction: "inbound", inbound-contract-design §9.5)
    // never enter the runnable inventory: the SDK dispatcher registered no
    // Test for them, so advertising a raw attachment would point at nothing.
    if (c.runnable === false) continue;
    const runnability = normalizeRunnability(c.runnability);
    byTestId.set(testId, {
      kind: "raw",
      testId,
      contractId: contract.id,
      caseKey: c.key,
      exportName: contract.exportName,
      ...(runnability ? { runnability } : {}),
    });
  }

  // Step 2 + 3: apply overlays, detect duplicates.
  const seenOverlayIds = new Set<string>();
  for (const marker of markers) {
    if (seenOverlayIds.has(marker.testId)) {
      errors.push({
        file: marker.exportName,
        error: `Duplicate bootstrap overlay for testId "${marker.testId}" (export "${marker.exportName}"). Per attachment-model §7.3 testId uniqueness is enforced.`,
      });
      continue;
    }
    seenOverlayIds.add(marker.testId);

    // rawBypass is available iff the target case declared `needs`
    // (hasNeeds === true). This is decoupled from needsSchema projection:
    // a case with a custom safeParse-only validator still satisfies
    // "explicit input can run the raw case" even when the JSON Schema
    // projection is null. If the schema projected, we decorate the
    // bypass slot with it; otherwise bypass is still advertised.
    const target = caseByTestId.get(marker.testId);
    const overlay: NormalizedBootstrapOverlayAttachment = {
      kind: "bootstrap-overlay",
      testId: marker.testId,
      exportName: marker.exportName,
      targetRef: { contractId: marker.contractId, caseKey: marker.caseKey },
      bootstrap: {},
      ...(target?.case.hasNeeds
        ? {
            rawBypass: {
              available: true as const,
              needsSchema: target.case.needsSchema,
            },
          }
        : {}),
    };
    byTestId.set(marker.testId, overlay);
  }

  const attachments = Array.from(byTestId.values());

  return { attachments, errors };
}

// Per-path mtime cache used by collectRawMaterials() to decide when to
// bust Node's ESM module cache on re-import. See the comment inside that
// function for the full reasoning.
const _importMtimeCache = new Map<string, number>();

interface RawFileMaterials {
  contracts: NormalizedContractMeta[];
  workflows: NormalizedWorkflowMeta[];
  markers: BootstrapOverlayMarker[];
  errors: ExtractionResult["errors"];
}

/**
 * GLU-221 phase 1 — best-effort line lookup for contracts/cases in a file,
 * derived from the STATIC AST extractor (`extractContractCases`). This is
 * the ONLY place real (non-fabricated) source lines exist for contract
 * declarations — the runtime-import path below has no notion of source
 * position at all. Keyed by `contractLocationKey(contractId, exportName,
 * protocol)` (see below), not contractId alone; case lines keyed by case key.
 *
 * Only recognizes the literal `contract.<protocol>("id", { cases: {...} })`
 * form (narrow mode, same as the fallback extractor) — a scoped/custom
 * factory (`contract.http.with(...)`, a wrapped `stableApi(...)`) is
 * invisible to static analysis and simply contributes no entry (caller
 * leaves `line`/`sourceFile` undefined, never guesses). Never throws:
 * `extractContractCases` already fails closed to `[]` on a parse error.
 */
/**
 * GLU-221 phase 1 P2-3 fix — composite key so two contracts that happen to
 * share the same `contractId` (a literal `contract.<protocol>(...)` export
 * AND a separate scoped/custom-factory contract that returns the SAME id —
 * ids are author-chosen strings, not guaranteed unique across exports) never
 * get their static line info cross-assigned to the wrong one. `JSON.stringify`
 * of the tuple, not naive string concatenation — avoids any ambiguity from a
 * separator character that could itself appear inside a user-chosen
 * `contractId` string literal.
 */
function contractLocationKey(contractId: string, exportName: string, protocol: string): string {
  return JSON.stringify([contractId, exportName, protocol]);
}

function staticContractLocations(content: string): Map<
  string,
  { line: number; endLine?: number; cases: Map<string, { line: number; endLine?: number }> }
> {
  const out = new Map<
    string,
    { line: number; endLine?: number; cases: Map<string, { line: number; endLine?: number }> }
  >();
  for (const c of extractContractCases(content)) {
    const cases = new Map<string, { line: number; endLine?: number }>();
    for (const cs of c.cases) {
      cases.set(cs.key, { line: cs.line, ...(cs.endLine !== undefined ? { endLine: cs.endLine } : {}) });
    }
    out.set(contractLocationKey(c.contractId, c.exportName, c.protocol), {
      line: c.line,
      ...(c.endLine !== undefined ? { endLine: c.endLine } : {}),
      cases,
    });
  }
  return out;
}

/**
 * Internal: dynamically import a file and collect raw materials
 * (contracts / flows / overlay markers / errors) without synthesis.
 * Both `extractContractFromFile` and `extractContractsFromProject` use
 * this — the former synthesizes per-file, the latter synthesizes
 * project-wide so cross-file overlay replacement and dedup work.
 *
 * @param projectRoot - GLU-221 phase 1, optional. When given, `sourceFile`
 *   on any extracted contract/case is `filePath` relative to this root
 *   (matching the `files{}` keys the scanner already reports). Omitted →
 *   `sourceFile` is left undefined (backward compatible; a caller that
 *   doesn't know its project root gets today's behavior, not an absolute
 *   path leaking local filesystem layout).
 */
async function collectRawMaterials(filePath: string, projectRoot?: string): Promise<RawFileMaterials> {
  const contracts: NormalizedContractMeta[] = [];
  const workflows: NormalizedWorkflowMeta[] = [];
  const markers: BootstrapOverlayMarker[] = [];
  const errors: ExtractionResult["errors"] = [];
  const absolutePath = resolve(filePath);

  try {
    // Cache-bust Node's ESM module cache so long-running hosts (MCP server,
    // editor integrations) see edits to a contract file on the next
    // extraction. Plain `await import(url)` serves the same module for the
    // process's lifetime, so without this a user editing a contract never
    // sees the change until the host restarts. Strategy: append
    // `?t=<mtimeMs>` ONLY when the file has changed since our last import.
    // Unchanged files reuse the same URL (cheap) and still hit Node's
    // cache; changed files get a fresh URL that triggers re-import.
    //
    // Why the conditional query, not always-on? Some ESM-aware tools
    // (e.g. Vite/Vitest) reserve query strings on import URLs for their
    // own transform pipeline. Leaving the URL clean unless we have a
    // real reason to bust keeps those tools working in their default path.
    let mtimeKey = 0;
    try {
      mtimeKey = statSync(absolutePath).mtimeMs;
    } catch {
      // stat failure: proceed without cache-bust.
    }
    const baseUrl = pathToFileURL(absolutePath).href;
    const lastSeen = _importMtimeCache.get(absolutePath);
    let importUrl: string;
    if (lastSeen === undefined || lastSeen === mtimeKey) {
      // First import or unchanged file: clean URL.
      importUrl = baseUrl;
    } else {
      // File changed since last import: new URL forces re-import.
      importUrl = `${baseUrl}?t=${mtimeKey}`;
    }
    _importMtimeCache.set(absolutePath, mtimeKey);
    const mod = await import(importUrl);
    for (const [exportName, rawValue] of Object.entries(mod)) {
      // Auto-resolve unbuilt FlowBuilder exports. User code like
      // `export const signup = contract.flow(...).step(...)` returns a
      // FlowBuilder (not a FlowContract) because `.build()` is optional.
      // Scanner must build it to reach the `_flow` projection.
      const value = autoBuildWorkflowBuilder(rawValue);
      if (isBuiltWorkflow(value)) {
        // The projection is pre-computed by the SDK's build() (S2.6) — carry
        // it verbatim, stamped with the export name like flows are.
        workflows.push({ ...value._projection, exportName });
      } else if (Array.isArray(value) && value.some(isBuiltWorkflow)) {
        // workflow.each() exports a BuiltWorkflow[] (addendum §3) — collect
        // every member's projection (rows share one structure; ids/tags vary).
        for (const member of value) {
          if (isBuiltWorkflow(member)) workflows.push({ ...member._projection, exportName });
        }
      } else if (isProtocolContract(value)) {
        contracts.push(protocolContractToNormalized(value, exportName));
      } else if (isBootstrapAttachment(value)) {
        const marker = bootstrapAttachmentToNormalized(value, exportName);
        if (marker) markers.push(marker);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push({ file: absolutePath, error: message });
  }

  // GLU-221 phase 1: stamp sourceFile + best-effort line info onto whatever
  // contracts the runtime import above produced. Best-effort/never-throw —
  // a read or parse failure here must not turn an otherwise-successful
  // extraction into an error (the contracts are already valid without it).
  if (contracts.length > 0) {
    const sourceFile = projectRoot ? relative(projectRoot, absolutePath) : undefined;
    let locations: ReturnType<typeof staticContractLocations> | undefined;
    try {
      locations = staticContractLocations(readFileSync(absolutePath, "utf-8"));
    } catch {
      locations = undefined;
    }
    for (const contract of contracts) {
      if (sourceFile !== undefined) contract.sourceFile = sourceFile;
      // GLU-221 phase 1 P2-3 fix — look up by the SAME composite key
      // `staticContractLocations` indexes by (contractId alone would merge
      // two different contracts that happen to share an author-chosen id).
      const loc = locations?.get(contractLocationKey(contract.id, contract.exportName, contract.protocol));
      if (loc) {
        contract.line = loc.line;
        if (loc.endLine !== undefined) contract.endLine = loc.endLine;
        for (const c of contract.cases) {
          const caseLoc = loc.cases.get(c.key);
          if (caseLoc) {
            if (sourceFile !== undefined) c.sourceFile = sourceFile;
            c.line = caseLoc.line;
            if (caseLoc.endLine !== undefined) c.endLine = caseLoc.endLine;
          }
        }
      }
    }
  }

  return { contracts, workflows, markers, errors };
}

/**
 * Extract contracts + attachments from a single file by dynamic import.
 * One file's import failure does not block others.
 *
 * Per-file synthesis: only this file's contracts/markers are seen.
 * Cross-file overlay replacement (overlay in fileA targets case in fileB)
 * only resolves at project level via `extractContractsFromProject`.
 *
 * @param projectRoot - GLU-221 phase 1, optional. Forwarded to
 *   `collectRawMaterials` so extracted contracts carry a project-root-
 *   relative `sourceFile`. Omitted → `sourceFile` stays undefined
 *   (backward compatible).
 */
export async function extractContractFromFile(
  filePath: string,
  projectRoot?: string,
): Promise<ExtractionResult> {
  const raw = await collectRawMaterials(filePath, projectRoot);
  const synth = synthesizeAttachments(raw.contracts, raw.markers);
  return {
    contracts: raw.contracts,
    attachments: synth.attachments,
    workflows: raw.workflows,
    errors: [...raw.errors, ...synth.errors],
  };
}

// =============================================================================
// Project-level extraction
// =============================================================================

/**
 * Find all .contract.{ts,js,mjs}, .workflow.{ts,js,mjs}, .flow.{ts,js,mjs},
 * and .bootstrap.{ts,js,mjs} files in a directory tree.
 *
 * v10 attachment model §7.4 mandates eager loading of `.bootstrap.` files
 * so overlay registrations fire during module evaluation. Without this,
 * filtered runs (CLI / MCP) could miss overlay registrations and silently
 * fall through to the no-overlay path.
 */
// Declaration files safe to runtime-import. Matched by SUFFIX, not substring:
// a `.workflow.` substring would also import `checkout.workflow.test.ts` /
// `foo.workflow.config.ts` — non-artifact files that can throw on import or
// run top-level side effects, and (for test files) violate the scanner's
// never-import-test-files invariant (codex 0.6 P2).
// Artifact files safe to eagerly runtime-import (contract / workflow / flow /
// bootstrap), derived from the canonical kind registry (kinds.ts).
const ARTIFACT_FILE_SUFFIXES = GLUBEAN_KINDS.filter((k) => k.runtimeArtifact).flatMap((k) =>
  buildSuffixes(k.stems),
);

function findContractAndFlowFiles(dir: string): string[] {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const full = resolve(d, entry);
      // Match scan()'s default skipDirs (node_modules/.git/dist/build) so the runtime
      // contract extraction sees the SAME file set as the projection scan — never
      // import GENERATED dist/build output (`*.contract.js`/`*.flow.js`), which would
      // make the OpenAPI doc diverge from the test/contract/workflow projections.
      if (entry === "node_modules" || entry === "dist" || entry === "build" || entry.startsWith(".")) continue;
      if (statSync(full).isDirectory()) walk(full);
      else {
        const base = basename(entry);
        if (ARTIFACT_FILE_SUFFIXES.some((suffix) => base.endsWith(suffix))) {
          files.push(full);
        }
      }
    }
  };
  walk(dir);
  return files;
}

/**
 * Extract contracts + attachments from all recognized files in a project.
 *
 * Project-level synthesis: collects raw materials (contracts, flows,
 * overlay markers) across all `.contract.` / `.flow.` / `.bootstrap.`
 * files, then runs `synthesizeAttachments` once. This is what enables
 * cross-file overlay replacement (overlay in `signup.bootstrap.ts`
 * replacing the raw entry for a case in `signup.contract.ts`) and
 * project-wide duplicate-overlay detection per §7.3.
 */
export async function extractContractsFromProject(
  dir: string,
): Promise<ExtractionResult> {
  const files = findContractAndFlowFiles(dir);
  if (files.length === 0) {
    return { contracts: [], attachments: [], workflows: [], errors: [] };
  }

  const allContracts: NormalizedContractMeta[] = [];
  const allWorkflows: NormalizedWorkflowMeta[] = [];
  const allMarkers: BootstrapOverlayMarker[] = [];
  const allErrors: ExtractionResult["errors"] = [];

  for (const filePath of files) {
    const raw = await collectRawMaterials(filePath, dir);
    allContracts.push(...raw.contracts);
    allWorkflows.push(...raw.workflows);
    allMarkers.push(...raw.markers);
    allErrors.push(...raw.errors);
  }

  const synth = synthesizeAttachments(allContracts, allMarkers);

  return {
    contracts: allContracts,
    attachments: synth.attachments,
    workflows: allWorkflows,
    errors: [...allErrors, ...synth.errors],
  };
}

// =============================================================================
// Eager overlay loading — attachment-model §7.4
//
// "Runner MUST eagerly load all *.contract.ts and *.bootstrap.ts files in
// the contracts root before resolving attachments. Overlay registration is
// a semantic input to runnable inventory; making it depend on import path
// leads to nondeterministic runs."
//
// CLI/MCP/ProjectRunner call this before any test runs so a filtered run
// (e.g. `glubean run path/to/single.contract.ts`) still picks up sibling
// `*.bootstrap.ts` overlay registrations.
// =============================================================================

/**
 * Eagerly import every `*.bootstrap.{ts,js,mjs}` file under `dir` so
 * `contract.bootstrap()` calls execute during module evaluation and
 * register their overlays in the SDK's bootstrap registry.
 *
 * Idempotent: subsequent calls re-import the same module URLs; Node's
 * ESM module cache short-circuits unless the file's mtime changed (the
 * same cache-busting strategy `collectRawMaterials` uses).
 *
 * Errors: per-file failures are returned; the caller decides whether
 * to abort or continue. We return errors instead of throwing because a
 * single broken bootstrap file shouldn't kill an otherwise-working run.
 */
export async function loadProjectOverlays(
  dir: string,
): Promise<{ loaded: string[]; errors: Array<{ file: string; error: string }> }> {
  const allFiles = findContractAndFlowFiles(dir);
  const bootstrapFiles = allFiles.filter((f) => basename(f).includes(".bootstrap."));
  const loaded: string[] = [];
  const errors: Array<{ file: string; error: string }> = [];

  for (const filePath of bootstrapFiles) {
    const absolutePath = resolve(filePath);
    try {
      let mtimeKey = 0;
      try {
        mtimeKey = statSync(absolutePath).mtimeMs;
      } catch {
        // fall through with mtimeKey=0
      }
      const baseUrl = pathToFileURL(absolutePath).href;
      const lastSeen = _importMtimeCache.get(absolutePath);
      const importUrl =
        lastSeen === undefined || lastSeen === mtimeKey
          ? baseUrl
          : `${baseUrl}?t=${mtimeKey}`;
      _importMtimeCache.set(absolutePath, mtimeKey);
      await import(importUrl);
      loaded.push(absolutePath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ file: absolutePath, error: message });
    }
  }

  return { loaded, errors };
}

// =============================================================================
// Backward-compat: isHttpContract — removed permanently in v0.2.
// =============================================================================

/** @deprecated Removed in v0.2 — HTTP now goes through isProtocolContract. */
export function isHttpContract(_val: unknown): never {
  throw new Error(
    "isHttpContract() was removed in v0.2. HTTP contracts now use the unified " +
      "isProtocolContract() shape (_projection.protocol === 'http').",
  );
}
