/**
 * Runtime contract extraction — dynamically imports .contract.ts modules
 * and extracts metadata from exported contract objects.
 *
 * This is the shared extraction layer used by scanner, CLI, and MCP.
 * Produces NormalizedContractMeta — a protocol-agnostic contract model.
 *
 * Supports:
 * - HttpContract (from contract.http.with())
 * - ProtocolContract (from contract.register() with adapter v2)
 */

import { pathToFileURL } from "node:url";
import { resolve, basename } from "node:path";
import { readdirSync, statSync } from "node:fs";

// =============================================================================
// Types
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

/** Normalized case metadata. Protocol-agnostic. */
export interface NormalizedCaseMeta {
  key: string;
  description?: string;
  lifecycle: CaseLifecycle;
  severity: CaseSeverity;
  deferredReason?: string;
  deprecatedReason?: string;
  requires?: CaseRequires;
  defaultRun?: CaseDefaultRun;
  schemaMount?: string;
  /** Protocol-specific expectations. HTTP: { status: 200 }, gRPC: { code: 0 } */
  protocolExpect?: Record<string, unknown>;
  responseSchema: unknown | null;
  /** Response headers schema (OpenAPI + runtime validation) */
  responseHeaders?: unknown | null;
  /** Response content-type (HTTP-specific) */
  responseContentType?: string;
  /** Named response examples for OpenAPI docs */
  examples?: Record<string, NormalizedExample>;
  /** Per-path-param metadata */
  paramSchemas?: Record<string, NormalizedParamMeta>;
  /** Per-query-param metadata */
  querySchemas?: Record<string, NormalizedParamMeta>;
  /** Fully merged extensions (defaults < contract < case). Keys are x-* OpenAPI extensions. */
  extensions?: Record<string, unknown>;
}

/** Normalized contract metadata. Protocol-agnostic. Evolved from ExtractedContract. */
export interface NormalizedContractMeta {
  id: string;
  exportName: string;
  protocol: string;
  /** Protocol-agnostic target. HTTP: "GET /users", gRPC: "Greeter/SayHello" */
  target: string;
  description?: string;
  feature?: string;
  instanceName?: string;
  security?: unknown;
  schemaMount?: string;
  requestSchema: unknown | null;
  /** Request content type (HTTP-specific; default application/json) */
  requestContentType?: string;
  /** Contract-level deprecation reason (propagates to all cases) */
  deprecated?: string;
  /** Contract-level merged extensions (defaults < contract). Keys are x-* OpenAPI extensions. */
  extensions?: Record<string, unknown>;
  protocolMeta?: Record<string, unknown>;
  cases: NormalizedCaseMeta[];
}

/**
 * @deprecated Alias for NormalizedContractMeta. Use NormalizedContractMeta directly.
 */
export type ExtractedContract = NormalizedContractMeta;

/** Result of extracting contracts from one or more files. */
export interface ExtractionResult {
  contracts: NormalizedContractMeta[];
  errors: Array<{ file: string; error: string }>;
}

// =============================================================================
// Duck typing
// =============================================================================

/**
 * Check if a value looks like an HttpContract (duck-typing).
 * HttpContract extends Array<Test> and has id + endpoint.
 */
export function isHttpContract(val: unknown): val is {
  id: string;
  endpoint: string;
  description?: string;
  feature?: string;
  instanceName?: string;
  security?: unknown;
  deprecated?: string;
  extensions?: Record<string, unknown>;
  requestContentType?: string;
  request?: { toJSONSchema?: () => unknown };
  _caseSchemas?: Record<string, {
    expectStatus?: number;
    responseSchema?: { toJSONSchema?: () => unknown };
    responseHeaders?: { toJSONSchema?: () => unknown };
    responseContentType?: string;
    example?: unknown;
    examples?: Record<string, { value: unknown; summary?: string; description?: string }>;
    paramSchemas?: Record<string, {
      schema?: { toJSONSchema?: () => unknown };
      description?: string;
      required?: boolean;
      deprecated?: boolean;
    }>;
    querySchemas?: Record<string, {
      schema?: { toJSONSchema?: () => unknown };
      description?: string;
      required?: boolean;
      deprecated?: boolean;
    }>;
    description?: string;
    deferred?: string;
    deprecated?: string;
    severity?: string;
    lifecycle?: string;
    requires?: string;
    defaultRun?: string;
    extensions?: Record<string, unknown>;
  }>;
} {
  return (
    Array.isArray(val) &&
    typeof (val as any).id === "string" &&
    typeof (val as any).endpoint === "string"
  );
}

/**
 * Check if a value looks like a ProtocolContract (duck-typing).
 * ProtocolContract extends Array<Test> and has _projection with protocol + target.
 */
export function isProtocolContract(val: unknown): val is {
  _projection: {
    protocol: string;
    target: string;
    description?: string;
    feature?: string;
    instanceName?: string;
    security?: unknown;
    schemaMount?: string;
    requestSchema?: unknown;
    cases: Array<{
      key: string;
      description?: string;
      lifecycle: string;
      severity: string;
      deferredReason?: string;
      deprecatedReason?: string;
      requires?: string;
      defaultRun?: string;
      schemaMount?: string;
      protocolExpect?: Record<string, unknown>;
      responseSchema?: unknown;
      protocolMeta?: Record<string, unknown>;
    }>;
    protocolMeta?: Record<string, unknown>;
  };
} {
  return (
    Array.isArray(val) &&
    typeof (val as any)._projection === "object" &&
    (val as any)._projection !== null &&
    typeof (val as any)._projection.protocol === "string" &&
    typeof (val as any)._projection.target === "string"
  );
}

// =============================================================================
// Schema conversion
// =============================================================================

/**
 * Try to convert a SchemaLike to JSON Schema using Zod v4's toJSONSchema.
 * Uses the schema's own instance method to avoid cross-instance issues.
 * Returns null if the schema is not a Zod type or conversion fails.
 */
export function schemaToJsonSchema(schema: unknown): unknown | null {
  if (!schema || typeof schema !== "object") return null;
  try {
    if (typeof (schema as any).toJSONSchema === "function") {
      return (schema as any).toJSONSchema();
    }
  } catch (err) {
    console.error(`[glubean:scanner] toJSONSchema failed: ${err instanceof Error ? err.message : err}`);
  }
  return null;
}

// =============================================================================
// Mapping functions
// =============================================================================

/**
 * Map an HttpContract to NormalizedContractMeta.
 */
function httpContractToNormalized(
  value: ReturnType<typeof isHttpContract extends (v: any) => v is infer T ? () => T : never>,
  exportName: string,
): NormalizedContractMeta {
  const cases: NormalizedCaseMeta[] = [];

  if (value._caseSchemas) {
    for (const [key, meta] of Object.entries(value._caseSchemas)) {
      // Lifecycle normalization
      const lifecycle: CaseLifecycle =
        meta.deprecated ? "deprecated" :
        meta.deferred ? "deferred" :
        "active";

      // Map per-param metadata (convert schema objects to JSON Schema)
      const mapParamMeta = (m?: Record<string, {
        schema?: { toJSONSchema?: () => unknown };
        description?: string;
        required?: boolean;
        deprecated?: boolean;
      }>): Record<string, NormalizedParamMeta> | undefined => {
        if (!m) return undefined;
        const result: Record<string, NormalizedParamMeta> = {};
        for (const [k, v] of Object.entries(m)) {
          result[k] = {
            schema: schemaToJsonSchema(v.schema),
            description: v.description,
            required: v.required,
            deprecated: v.deprecated,
          };
        }
        return result;
      };

      // Normalize examples: prefer meta.examples, fall back to meta.example (single)
      let examples: Record<string, NormalizedExample> | undefined;
      if (meta.examples) {
        examples = {};
        for (const [name, ex] of Object.entries(meta.examples)) {
          examples[name] = { value: ex.value, summary: ex.summary, description: ex.description };
        }
      } else if (meta.example !== undefined) {
        examples = { default: { value: meta.example } };
      }

      cases.push({
        key,
        description: meta.description,
        lifecycle,
        severity: (meta.severity as CaseSeverity) ?? "warning",
        deferredReason: meta.deferred,
        deprecatedReason: meta.deprecated,
        requires: meta.requires as CaseRequires | undefined,
        defaultRun: meta.defaultRun as CaseDefaultRun | undefined,
        schemaMount: "response.body",
        protocolExpect: meta.expectStatus != null
          ? { status: meta.expectStatus }
          : undefined,
        responseSchema: schemaToJsonSchema(meta.responseSchema),
        responseHeaders: schemaToJsonSchema(meta.responseHeaders),
        responseContentType: meta.responseContentType,
        examples,
        paramSchemas: mapParamMeta(meta.paramSchemas),
        querySchemas: mapParamMeta(meta.querySchemas),
        extensions: meta.extensions,
      });
    }
  }

  return {
    id: value.id,
    exportName,
    protocol: "http",
    target: value.endpoint,
    description: value.description,
    feature: value.feature,
    instanceName: value.instanceName,
    security: value.security,
    schemaMount: "response.body",
    requestSchema: schemaToJsonSchema(value.request),
    requestContentType: value.requestContentType,
    deprecated: value.deprecated,
    extensions: value.extensions,
    cases,
  };
}

/**
 * Map a ProtocolContract's _projection to NormalizedContractMeta.
 */
function protocolContractToNormalized(
  value: { _projection: any },
  exportName: string,
): NormalizedContractMeta {
  const proj = value._projection;
  return {
    id: proj.id ?? exportName, // prefer injected id, fall back to export name
    exportName,
    protocol: proj.protocol,
    target: proj.target,
    description: proj.description,
    feature: proj.feature,
    instanceName: proj.instanceName,
    security: proj.security,
    schemaMount: proj.schemaMount,
    // Normalize schemas: if adapter returned live schema objects, convert to JSON Schema
    requestSchema: schemaToJsonSchema(proj.requestSchema) ?? proj.requestSchema ?? null,
    protocolMeta: proj.protocolMeta,
    cases: (proj.cases ?? []).map((c: any) => ({
      key: c.key,
      description: c.description,
      lifecycle: c.lifecycle ?? "active",
      severity: c.severity ?? "warning",
      deferredReason: c.deferredReason,
      deprecatedReason: c.deprecatedReason,
      requires: c.requires,
      defaultRun: c.defaultRun,
      schemaMount: c.schemaMount,
      protocolExpect: c.protocolExpect,
      // Normalize: try JSON Schema conversion, fall back to raw value
      responseSchema: schemaToJsonSchema(c.responseSchema) ?? c.responseSchema ?? null,
    })),
  };
}

// =============================================================================
// File-level extraction
// =============================================================================

/**
 * Extract contracts from a single file by dynamic import.
 * Supports HttpContract (.with()) and ProtocolContract (register() v2).
 */
export async function extractContractFromFile(filePath: string): Promise<ExtractionResult> {
  const contracts: NormalizedContractMeta[] = [];
  const errors: ExtractionResult["errors"] = [];
  const absolutePath = resolve(filePath);

  try {
    const mod = await import(pathToFileURL(absolutePath).href);
    for (const [exportName, value] of Object.entries(mod)) {
      if (isHttpContract(value)) {
        contracts.push(httpContractToNormalized(value, exportName));
      } else if (isProtocolContract(value)) {
        contracts.push(protocolContractToNormalized(value, exportName));
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push({ file: absolutePath, error: message });
  }

  return { contracts, errors };
}

// =============================================================================
// Project-level extraction
// =============================================================================

/**
 * Find all .contract.{ts,js,mjs} files in a directory tree.
 */
function findContractFiles(dir: string): string[] {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const full = resolve(d, entry);
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      if (statSync(full).isDirectory()) walk(full);
      else if (basename(entry).includes(".contract.")) files.push(full);
    }
  };
  walk(dir);
  return files;
}

/**
 * Extract contracts from all .contract.{ts,js,mjs} files in a project.
 * Each file is imported independently — one file's failure does not block others.
 */
export async function extractContractsFromProject(dir: string): Promise<ExtractionResult> {
  const contractFiles = findContractFiles(dir);
  if (contractFiles.length === 0) return { contracts: [], errors: [] };

  const allContracts: NormalizedContractMeta[] = [];
  const allErrors: ExtractionResult["errors"] = [];

  for (const filePath of contractFiles) {
    const { contracts, errors } = await extractContractFromFile(filePath);
    allContracts.push(...contracts);
    allErrors.push(...errors);
  }

  return { contracts: allContracts, errors: allErrors };
}
