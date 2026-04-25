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
 *   - NormalizedFlowMeta — JSON-safe flow projection (mirrors
 *     ExtractedFlowProjection, plus `exportName`)
 *
 * Schema conversion: anywhere scanner sees a value with `.toJSONSchema()`
 * it invokes that method. This handles Zod schemas embedded inside
 * adapter-defined `schemas` opaque blobs without knowing the protocol.
 */

import { pathToFileURL } from "node:url";
import { resolve, basename } from "node:path";
import { readdirSync, statSync } from "node:fs";

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
  /**
   * Runnability metadata — attachment-model §7.2. `requireAttachment`
   * blocks raw execution (case MUST run via a bootstrap overlay). Lives
   * as a first-class field, not in `extensions`, per proposal.
   */
  runnability?: {
    requireAttachment?: boolean;
  };
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
}

/**
 * @deprecated Alias for NormalizedContractMeta. Use directly.
 */
export type ExtractedContract = NormalizedContractMeta;

// --- Flow --------------------------------------------------------------------

/**
 * Single step in a flow projection. Discriminated by `kind`.
 */
export type NormalizedFlowStep =
  | {
      kind: "contract-call";
      name?: string;
      contractId: string;
      caseKey: string;
      protocol: string;
      target: string;
      inputs?: NormalizedFieldMapping[];
      outputs?: NormalizedFieldMapping[];
    }
  | {
      kind: "compute";
      name?: string;
      reads: string[];
      writes: string[];
    };

export interface NormalizedFieldMapping {
  target: string;
  source:
    | { kind: "path"; path: string }
    | { kind: "literal"; value: unknown }
    | { kind: "pass-through" };
}

/**
 * Protocol-agnostic flow metadata. Mirrors `ExtractedFlowProjection`.
 */
export interface NormalizedFlowMeta {
  id: string;
  exportName: string;
  protocol: "flow";
  description?: string;
  tags?: string[];
  extensions?: Record<string, unknown>;
  setupDynamic?: true;
  steps: NormalizedFlowStep[];
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
  /** Whether the case declares `runnability.requireAttachment` (raw blocked). */
  runnability?: { requireAttachment?: boolean };
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

/**
 * Flow attachment — orchestrates a sequence of contract calls under a
 * single test id. Distinct from raw / overlay (no underlying case).
 */
export interface NormalizedFlowAttachment {
  kind: "flow";
  /** Flow test id (`flowId`). */
  testId: string;
  exportName: string;
  flow: NormalizedFlowMeta;
}

/** Discriminated attachment entry. One per testId in the inventory. */
export type NormalizedAttachmentMeta =
  | NormalizedRawAttachment
  | NormalizedBootstrapOverlayAttachment
  | NormalizedFlowAttachment;

/** Result of extracting contracts/attachments from one or more files. */
export interface ExtractionResult {
  contracts: NormalizedContractMeta[];
  /**
   * Attachment inventory per attachment-model §7.3. Always present
   * (may be empty). Replaces the previous `flows?: NormalizedFlowMeta[]`
   * top-level field — flows now appear here as `kind: "flow"` entries.
   */
  attachments: NormalizedAttachmentMeta[];
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
 * Check if a value looks like a FlowContract.
 * FlowContract extends Array<Test> and has `_flow.protocol === "flow"`.
 *
 * May also carry `_extracted` — a pre-computed ExtractedFlowProjection
 * populated by the SDK's flow builder via `normalizeFlow(_flow)`. When
 * present it is the source of truth for scanner output (full field
 * mappings, compute reads/writes). When absent we degrade to duck-typing
 * `_flow` directly (no lens proxy tracing in scanner since it is
 * dependency-free).
 */
export function isFlowContract(val: unknown): val is {
  _flow: {
    id: string;
    protocol: "flow";
    description?: string;
    tags?: string[];
    extensions?: Record<string, unknown>;
    setup?: (...args: any[]) => unknown;
    teardown?: (...args: any[]) => unknown;
    steps: Array<any>;
  };
  _extracted?: {
    id: string;
    protocol: "flow";
    description?: string;
    tags?: string[];
    extensions?: Record<string, unknown>;
    setupDynamic?: true;
    steps: Array<any>;
  };
} {
  return (
    Array.isArray(val) &&
    typeof (val as any)._flow === "object" &&
    (val as any)._flow !== null &&
    (val as any)._flow.protocol === "flow"
  );
}

// =============================================================================
// Mapping: projection → NormalizedContractMeta
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
      runnability: c.runnability,
      hasNeeds: c.hasNeeds,
      needsSchema: c.needsSchema,
    })),
  };
}

function flowContractToNormalized(
  value: { _flow: any; _extracted?: any },
  exportName: string,
): NormalizedFlowMeta {
  // Prefer the pre-computed extracted projection. The SDK's flow builder
  // populates `_extracted` via `normalizeFlow(_flow)` — this path carries
  // full FieldMapping data for `.step()` lenses and reads/writes for
  // `.compute()` nodes. Scanner just attaches `exportName`.
  if (value._extracted) {
    const ex = value._extracted;
    return {
      id: ex.id,
      exportName,
      protocol: "flow",
      description: ex.description,
      tags: ex.tags,
      extensions: ex.extensions,
      setupDynamic: ex.setupDynamic,
      steps: (ex.steps ?? []).map((s: any): NormalizedFlowStep => {
        if (s.kind === "compute") {
          return {
            kind: "compute",
            name: s.name,
            reads: s.reads ?? [],
            writes: s.writes ?? [],
          };
        }
        return {
          kind: "contract-call",
          name: s.name,
          contractId: s.contractId ?? "",
          caseKey: s.caseKey ?? "",
          protocol: s.protocol ?? "",
          target: s.target ?? "",
          inputs: s.inputs,
          outputs: s.outputs,
        };
      }),
    };
  }

  // Fallback: duck-type `_flow` directly. Lens tracing is unavailable
  // here (scanner is dep-free); callers downstream lose FieldMappings +
  // compute reads/writes. In practice this only fires for flows
  // constructed outside the canonical SDK path (e.g. test fixtures).
  const f = value._flow;
  return {
    id: f.id,
    exportName,
    protocol: "flow",
    description: f.description,
    tags: f.tags,
    extensions: f.extensions,
    setupDynamic: f.setup ? true : undefined,
    steps: (f.steps ?? []).map((s: any): NormalizedFlowStep => {
      if (s.kind === "compute") {
        return { kind: "compute", name: s.name, reads: [], writes: [] };
      }
      return {
        kind: "contract-call",
        name: s.name,
        contractId: s.contract?._projection?.id ?? s.ref?.contractId ?? "",
        caseKey: s.caseKey ?? s.ref?.caseKey ?? "",
        protocol: s.ref?.protocol ?? "",
        target: s.ref?.target ?? "",
      };
    }),
  };
}

// =============================================================================
// FlowBuilder auto-build
// =============================================================================

/**
 * If `val` is an unbuilt FlowBuilder (from `contract.flow(id).step(...)`
 * without a trailing `.build()`), call `.build()` to resolve it to a
 * FlowContract. Scanner is dep-free, so we duck-type the builder shape.
 */
function autoBuildFlowBuilder(val: unknown): unknown {
  if (
    typeof val === "object" &&
    val !== null &&
    (val as any).__glubean_type === "flow-builder" &&
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
 *  4. Append flows as `kind: "flow"` entries.
 *
 * Overlays whose testId doesn't match any contract case stand alone —
 * we still emit them as `bootstrap-overlay` (no `rawBypass`, no targetRef
 * verification). This keeps cross-file overlay registration discoverable
 * even when the contract module hasn't been scanned yet.
 */
export function synthesizeAttachments(
  contracts: NormalizedContractMeta[],
  flows: NormalizedFlowMeta[],
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

  // Step 1: seed raw entries. Reads `runnability.requireAttachment`
  // directly from the case projection (post-Phase-2f-fix: the adapter
  // now threads it as a first-class field, no longer hidden under
  // `extensions`).
  const byTestId = new Map<string, NormalizedAttachmentMeta>();
  for (const [testId, { contract, case: c }] of caseByTestId) {
    const requireAttachment = c.runnability?.requireAttachment;
    byTestId.set(testId, {
      kind: "raw",
      testId,
      contractId: contract.id,
      caseKey: c.key,
      exportName: contract.exportName,
      ...(requireAttachment !== undefined
        ? { runnability: { requireAttachment } }
        : {}),
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

  // Step 4: append flows.
  const attachments = Array.from(byTestId.values());
  for (const flow of flows) {
    attachments.push({
      kind: "flow",
      testId: flow.id,
      exportName: flow.exportName,
      flow,
    });
  }

  return { attachments, errors };
}

// Per-path mtime cache used by collectRawMaterials() to decide when to
// bust Node's ESM module cache on re-import. See the comment inside that
// function for the full reasoning.
const _importMtimeCache = new Map<string, number>();

interface RawFileMaterials {
  contracts: NormalizedContractMeta[];
  flows: NormalizedFlowMeta[];
  markers: BootstrapOverlayMarker[];
  errors: ExtractionResult["errors"];
}

/**
 * Internal: dynamically import a file and collect raw materials
 * (contracts / flows / overlay markers / errors) without synthesis.
 * Both `extractContractFromFile` and `extractContractsFromProject` use
 * this — the former synthesizes per-file, the latter synthesizes
 * project-wide so cross-file overlay replacement and dedup work.
 */
async function collectRawMaterials(filePath: string): Promise<RawFileMaterials> {
  const contracts: NormalizedContractMeta[] = [];
  const flows: NormalizedFlowMeta[] = [];
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
      const value = autoBuildFlowBuilder(rawValue);
      if (isFlowContract(value)) {
        flows.push(flowContractToNormalized(value, exportName));
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

  return { contracts, flows, markers, errors };
}

/**
 * Extract contracts + attachments from a single file by dynamic import.
 * One file's import failure does not block others.
 *
 * Per-file synthesis: only this file's contracts/flows/markers are seen.
 * Cross-file overlay replacement (overlay in fileA targets case in fileB)
 * only resolves at project level via `extractContractsFromProject`.
 */
export async function extractContractFromFile(
  filePath: string,
): Promise<ExtractionResult> {
  const raw = await collectRawMaterials(filePath);
  const synth = synthesizeAttachments(raw.contracts, raw.flows, raw.markers);
  return {
    contracts: raw.contracts,
    attachments: synth.attachments,
    errors: [...raw.errors, ...synth.errors],
  };
}

// =============================================================================
// Project-level extraction
// =============================================================================

/**
 * Find all .contract.{ts,js,mjs}, .flow.{ts,js,mjs}, and
 * .bootstrap.{ts,js,mjs} files in a directory tree.
 *
 * v10 attachment model §7.4 mandates eager loading of `.bootstrap.` files
 * so overlay registrations fire during module evaluation. Without this,
 * filtered runs (CLI / MCP) could miss overlay registrations and silently
 * fall through to the no-overlay path.
 */
function findContractAndFlowFiles(dir: string): string[] {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const full = resolve(d, entry);
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      if (statSync(full).isDirectory()) walk(full);
      else {
        const base = basename(entry);
        if (
          base.includes(".contract.") ||
          base.includes(".flow.") ||
          base.includes(".bootstrap.")
        ) {
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
    return { contracts: [], attachments: [], errors: [] };
  }

  const allContracts: NormalizedContractMeta[] = [];
  const allFlows: NormalizedFlowMeta[] = [];
  const allMarkers: BootstrapOverlayMarker[] = [];
  const allErrors: ExtractionResult["errors"] = [];

  for (const filePath of files) {
    const raw = await collectRawMaterials(filePath);
    allContracts.push(...raw.contracts);
    allFlows.push(...raw.flows);
    allMarkers.push(...raw.markers);
    allErrors.push(...raw.errors);
  }

  const synth = synthesizeAttachments(allContracts, allFlows, allMarkers);

  return {
    contracts: allContracts,
    attachments: synth.attachments,
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
