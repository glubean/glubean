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

/** Result of extracting contracts/flows from one or more files. */
export interface ExtractionResult {
  contracts: NormalizedContractMeta[];
  flows?: NormalizedFlowMeta[];
  errors: Array<{ file: string; error: string }>;
}

// =============================================================================
// Duck typing
// =============================================================================

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
} {
  return (
    Array.isArray(val) &&
    typeof (val as any)._projection === "object" &&
    (val as any)._projection !== null &&
    typeof (val as any)._projection.protocol === "string" &&
    typeof (val as any)._projection.target === "string" &&
    (val as any)._projection.protocol !== "flow"
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
// Schema conversion — embedded .toJSONSchema() recursive walk
// =============================================================================

/**
 * Convert a live schema (Zod/Valibot/etc.) to a JSON Schema plain object.
 * Falls back to passing through or null.
 */
export function schemaToJsonSchema(schema: unknown): unknown | null {
  if (!schema || typeof schema !== "object") return null;
  try {
    if (typeof (schema as any).toJSONSchema === "function") {
      return (schema as any).toJSONSchema();
    }
  } catch (err) {
    console.error(
      `[glubean:scanner] toJSONSchema failed: ${err instanceof Error ? err.message : err}`,
    );
  }
  return null;
}

/**
 * Recursively walk a value converting any embedded Zod/valibot schemas
 * (detected by `.toJSONSchema()` method) to plain JSON Schema objects.
 * Other values pass through as-is.
 *
 * Used by scanner to produce JSON-safe output even when adapter didn't run
 * `.normalize()` (e.g. when we read `_projection` directly).
 */
export function deepNormalizeSchemas(value: unknown, depth = 0): unknown {
  if (depth > 20) return value;
  if (value == null) return value;
  if (typeof value !== "object") return value;
  // Has toJSONSchema? Convert it.
  if (typeof (value as any).toJSONSchema === "function") {
    const converted = schemaToJsonSchema(value);
    if (converted != null) return converted;
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((v) => deepNormalizeSchemas(v, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = deepNormalizeSchemas(v, depth + 1);
  }
  return out;
}

// =============================================================================
// Mapping: projection → NormalizedContractMeta
// =============================================================================

function protocolContractToNormalized(
  value: { _projection: any },
  exportName: string,
): NormalizedContractMeta {
  const proj = value._projection;
  return {
    id: proj.id ?? exportName,
    exportName,
    protocol: proj.protocol,
    target: proj.target,
    description: proj.description,
    feature: proj.feature,
    instanceName: proj.instanceName,
    tags: proj.tags,
    deprecated: proj.deprecated,
    extensions: proj.extensions,
    schemas: proj.schemas != null ? deepNormalizeSchemas(proj.schemas) : undefined,
    meta: proj.meta,
    cases: (proj.cases ?? []).map((c: any): NormalizedCaseMeta => ({
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
      schemas: c.schemas != null ? deepNormalizeSchemas(c.schemas) : undefined,
      meta: c.meta,
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

// Per-path mtime cache used by extractContractFromFile() to decide when
// to bust Node's ESM module cache on re-import. See the comment inside
// that function for the full reasoning.
const _importMtimeCache = new Map<string, number>();

/**
 * Extract contracts + flows from a single file by dynamic import.
 * One file's import failure does not block others.
 */
export async function extractContractFromFile(
  filePath: string,
): Promise<ExtractionResult> {
  const contracts: NormalizedContractMeta[] = [];
  const flows: NormalizedFlowMeta[] = [];
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
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push({ file: absolutePath, error: message });
  }

  return { contracts, flows: flows.length > 0 ? flows : undefined, errors };
}

// =============================================================================
// Project-level extraction
// =============================================================================

/**
 * Find all .contract.{ts,js,mjs} and .flow.{ts,js,mjs} files in a directory tree.
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
        if (base.includes(".contract.") || base.includes(".flow.")) {
          files.push(full);
        }
      }
    }
  };
  walk(dir);
  return files;
}

/**
 * Extract contracts + flows from all recognized files in a project.
 */
export async function extractContractsFromProject(
  dir: string,
): Promise<ExtractionResult> {
  const files = findContractAndFlowFiles(dir);
  if (files.length === 0) return { contracts: [], errors: [] };

  const allContracts: NormalizedContractMeta[] = [];
  const allFlows: NormalizedFlowMeta[] = [];
  const allErrors: ExtractionResult["errors"] = [];

  for (const filePath of files) {
    const { contracts, flows, errors } = await extractContractFromFile(filePath);
    allContracts.push(...contracts);
    if (flows) allFlows.push(...flows);
    allErrors.push(...errors);
  }

  return {
    contracts: allContracts,
    flows: allFlows.length > 0 ? allFlows : undefined,
    errors: allErrors,
  };
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
