/**
 * Runtime contract extraction — dynamically imports .contract.ts modules
 * and extracts metadata from exported HttpContract objects.
 *
 * This is the shared extraction layer used by scanner, CLI, and MCP.
 * Works for both old contract.http("id", spec) and new
 * contract.http.with("name", defaults)("id", spec) syntax.
 */

import { pathToFileURL } from "node:url";
import { resolve, basename } from "node:path";
import { readdirSync, statSync } from "node:fs";

// =============================================================================
// Types
// =============================================================================

/** Extracted contract metadata from a single HttpContract export. */
export interface ExtractedContract {
  id: string;
  exportName: string;
  endpoint: string;
  description?: string;
  feature?: string;
  instanceName?: string;
  security?: unknown;
  requestSchema: unknown | null;
  cases: Array<{
    key: string;
    description?: string;
    expectStatus?: number;
    deferred?: string;
    requires?: string;
    defaultRun?: string;
    responseSchema: unknown | null;
  }>;
}

/** Result of extracting contracts from one or more files. */
export interface ExtractionResult {
  contracts: ExtractedContract[];
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
  request?: { toJSONSchema?: () => unknown };
  _caseSchemas?: Record<string, {
    expectStatus?: number;
    responseSchema?: { toJSONSchema?: () => unknown };
    description?: string;
    deferred?: string;
    requires?: string;
    defaultRun?: string;
  }>;
} {
  return (
    Array.isArray(val) &&
    typeof (val as any).id === "string" &&
    typeof (val as any).endpoint === "string"
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
// File-level extraction
// =============================================================================

/**
 * Extract contracts from a single file by dynamic import.
 * Works for both old and new (.with()) contract syntax.
 */
export async function extractContractFromFile(filePath: string): Promise<ExtractionResult> {
  const contracts: ExtractedContract[] = [];
  const errors: ExtractionResult["errors"] = [];
  const absolutePath = resolve(filePath);

  try {
    const mod = await import(pathToFileURL(absolutePath).href);
    for (const [exportName, value] of Object.entries(mod)) {
      if (!isHttpContract(value)) continue;

      const requestSchema = schemaToJsonSchema(value.request);
      const cases: ExtractedContract["cases"] = [];

      if (value._caseSchemas) {
        for (const [key, caseMeta] of Object.entries(value._caseSchemas)) {
          cases.push({
            key,
            description: caseMeta.description,
            expectStatus: caseMeta.expectStatus,
            deferred: caseMeta.deferred,
            requires: caseMeta.requires,
            defaultRun: caseMeta.defaultRun,
            responseSchema: schemaToJsonSchema(caseMeta.responseSchema),
          });
        }
      }

      contracts.push({
        id: value.id,
        exportName,
        endpoint: value.endpoint,
        description: value.description,
        feature: value.feature,
        instanceName: value.instanceName,
        security: value.security,
        requestSchema,
        cases,
      });
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

  const allContracts: ExtractedContract[] = [];
  const allErrors: ExtractionResult["errors"] = [];

  for (const filePath of contractFiles) {
    const { contracts, errors } = await extractContractFromFile(filePath);
    allContracts.push(...contracts);
    allErrors.push(...errors);
  }

  return { contracts: allContracts, errors: allErrors };
}
