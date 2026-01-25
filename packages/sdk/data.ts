/**
 * Data loading utilities for test.each data-driven tests.
 *
 * These helpers load test data from various file formats and directories,
 * returning plain arrays suitable for `test.each()`.
 *
 * All paths are **relative to the project root** (the directory containing
 * `deno.json`). The runner guarantees that `Deno.cwd()` points to the
 * project root at execution time.
 *
 * @module data
 *
 * @example Load JSON (use native import instead)
 * ```ts
 * import cases from "./data/cases.json" with { type: "json" };
 * export const tests = test.each(cases)("case-$id", fn);
 * ```
 *
 * @example Load CSV
 * ```ts
 * import { test, fromCsv } from "@glubean/sdk";
 * export const tests = test.each(await fromCsv("./data/cases.csv"))
 *   ("case-$id", async (ctx, row) => { ... });
 * ```
 *
 * @example Load YAML
 * ```ts
 * import { test, fromYaml } from "@glubean/sdk";
 * export const tests = test.each(await fromYaml("./data/cases.yaml"))
 *   ("case-$id", async (ctx, row) => { ... });
 * ```
 *
 * @example Load JSONL
 * ```ts
 * import { test, fromJsonl } from "@glubean/sdk";
 * export const tests = test.each(await fromJsonl("./data/requests.jsonl"))
 *   ("req-$index", async (ctx, row) => { ... });
 * ```
 *
 * @example Load directory of files
 * ```ts
 * import { test, fromDir } from "@glubean/sdk";
 * export const tests = test.each(await fromDir("./cases/"))
 *   ("case-$_name", async (ctx, row) => { ... });
 * ```
 */

import { parse as parseYaml } from "@std/yaml";

// =============================================================================
// Shared utilities
// =============================================================================

/**
 * Normalize `string | string[]` to `string[]`.
 * @internal
 */
export function toArray(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Resolve a dot-separated path into a nested object.
 * Returns `undefined` if any segment is missing.
 *
 * @internal
 * @example
 * pickByPath({ a: { b: [1, 2] } }, "a.b") // → [1, 2]
 */
function pickByPath(obj: unknown, path: string): unknown {
  let current = obj;
  for (const segment of path.split(".")) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Extract an array from parsed data using an optional `pick` path.
 * If no pick is provided, the data must be a top-level array.
 * Provides helpful error messages when the data shape is unexpected.
 *
 * @internal
 */
function extractArray<T extends Record<string, unknown>>(
  data: unknown,
  pick: string | undefined,
  sourcePath: string
): T[] {
  if (pick) {
    const picked = pickByPath(data, pick);
    if (!Array.isArray(picked)) {
      throw new Error(
        `${sourcePath}: pick path "${pick}" did not resolve to an array. ` +
          `Got: ${picked === undefined ? "undefined" : typeof picked}`
      );
    }
    return picked as T[];
  }

  if (Array.isArray(data)) {
    return data as T[];
  }

  // Data is an object — provide helpful error with discovered array fields
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const arrayFields: string[] = [];
    for (const [key, value] of Object.entries(
      data as Record<string, unknown>
    )) {
      if (Array.isArray(value)) {
        arrayFields.push(`"${key}" (${value.length} items)`);
      }
    }
    const hint =
      arrayFields.length > 0
        ? `\nFound these array fields: ${arrayFields.join(", ")}` +
          `\nHint: use { pick: "${
            arrayFields[0]?.match(/"([^"]+)"/)?.[1] ?? ""
          }" } to select one.`
        : "\nNo array fields found at the top level.";

    throw new Error(`${sourcePath}: root is an object, not an array.${hint}`);
  }

  throw new Error(`${sourcePath}: expected an array, got ${typeof data}`);
}

// =============================================================================
// CSV loader
// =============================================================================

/**
 * Options for loading CSV files.
 */
export interface FromCsvOptions {
  /**
   * Whether the first row contains column headers.
   * When true (default), each row is returned as a `Record<string, string>`
   * keyed by the header values.
   * When false, rows are returned with numeric keys ("0", "1", "2", ...).
   *
   * @default true
   */
  headers?: boolean;

  /**
   * Column separator character.
   * @default ","
   */
  separator?: string;
}

/**
 * Load test data from a CSV file.
 *
 * Returns an array of records. All values are strings (CSV has no type info).
 * Use the returned data with `test.each()` for data-driven tests.
 *
 * @param path Path to the CSV file, relative to project root
 * @param options CSV parsing options
 * @returns Array of row objects
 *
 * @example Basic usage
 * ```ts
 * import { test, fromCsv } from "@glubean/sdk";
 *
 * export const tests = test.each(await fromCsv("./data/cases.csv"))
 *   ("case-$index-$country", async (ctx, row) => {
 *     const res = await ctx.http.get(`${baseUrl}/users/${row.id}`);
 *     ctx.assert(res.status === row.expected, "status check");
 *   });
 * ```
 *
 * @example Custom separator
 * ```ts
 * const data = await fromCsv("./data/cases.tsv", { separator: "\t" });
 * ```
 */
export async function fromCsv<
  T extends Record<string, string> = Record<string, string>
>(path: string, options?: FromCsvOptions): Promise<T[]> {
  const content = await Deno.readTextFile(path);
  const separator = options?.separator ?? ",";
  const hasHeaders = options?.headers !== false;

  const lines = content.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) return [];

  const parseLine = (line: string): string[] => {
    const fields: string[] = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (inQuotes) {
        if (char === '"') {
          if (i + 1 < line.length && line[i + 1] === '"') {
            current += '"';
            i++; // Skip escaped quote
          } else {
            inQuotes = false;
          }
        } else {
          current += char;
        }
      } else {
        if (char === '"') {
          inQuotes = true;
        } else if (char === separator) {
          fields.push(current.trim());
          current = "";
        } else {
          current += char;
        }
      }
    }
    fields.push(current.trim());
    return fields;
  };

  if (hasHeaders) {
    const headers = parseLine(lines[0]);
    return lines.slice(1).map((line) => {
      const values = parseLine(line);
      const record: Record<string, string> = {};
      for (let i = 0; i < headers.length; i++) {
        record[headers[i]] = values[i] ?? "";
      }
      return record as T;
    });
  } else {
    return lines.map((line) => {
      const values = parseLine(line);
      const record: Record<string, string> = {};
      for (let i = 0; i < values.length; i++) {
        record[String(i)] = values[i];
      }
      return record as T;
    });
  }
}

// =============================================================================
// YAML loader
// =============================================================================

/**
 * Options for loading YAML files.
 */
export interface FromYamlOptions {
  /**
   * Dot-path to the array inside the YAML document.
   * Required when the root is not an array.
   *
   * @example "testCases"
   * @example "data.requests"
   */
  pick?: string;
}

/**
 * Load test data from a YAML file.
 *
 * The file must contain a top-level array, or use the `pick` option
 * to specify the dot-path to an array within the document.
 *
 * @param path Path to the YAML file, relative to project root
 * @param options YAML loading options
 * @returns Array of row objects
 *
 * @example Top-level array
 * ```ts
 * // cases.yaml:
 * // - id: 1
 * //   expected: 200
 * // - id: 999
 * //   expected: 404
 *
 * import { test, fromYaml } from "@glubean/sdk";
 * export const tests = test.each(await fromYaml("./data/cases.yaml"))
 *   ("case-$id", async (ctx, row) => { ... });
 * ```
 *
 * @example Nested array with pick
 * ```ts
 * // collection.yaml:
 * // info:
 * //   name: API Tests
 * // testCases:
 * //   - id: 1
 * //     expected: 200
 *
 * const data = await fromYaml("./data/collection.yaml", { pick: "testCases" });
 * ```
 */
export async function fromYaml<
  T extends Record<string, unknown> = Record<string, unknown>
>(path: string, options?: FromYamlOptions): Promise<T[]> {
  const content = await Deno.readTextFile(path);
  const data = parseYaml(content);
  return extractArray<T>(data, options?.pick, path);
}

// =============================================================================
// JSONL loader
// =============================================================================

/**
 * Load test data from a JSONL (JSON Lines) file.
 *
 * Each line must be a valid JSON object. Empty lines are skipped.
 *
 * @param path Path to the JSONL file, relative to project root
 * @returns Array of row objects
 *
 * @example
 * ```ts
 * // requests.jsonl:
 * // {"method":"GET","url":"/users/1","expected":200}
 * // {"method":"GET","url":"/users/999","expected":404}
 *
 * import { test, fromJsonl } from "@glubean/sdk";
 * export const tests = test.each(await fromJsonl("./data/requests.jsonl"))
 *   ("req-$index", async (ctx, row) => { ... });
 * ```
 */
export async function fromJsonl<
  T extends Record<string, unknown> = Record<string, unknown>
>(path: string): Promise<T[]> {
  const content = await Deno.readTextFile(path);
  const lines = content.split("\n").filter((line) => line.trim() !== "");
  return lines.map((line, index) => {
    try {
      return JSON.parse(line) as T;
    } catch {
      throw new Error(
        `${path}: invalid JSON at line ${index + 1}: ${line.substring(0, 80)}`
      );
    }
  });
}

// =============================================================================
// GraphQL query loader
// =============================================================================

/**
 * Load a GraphQL query from a `.gql` or `.graphql` file.
 *
 * Using external `.gql` files instead of inline strings enables full IDE
 * support: syntax highlighting, field autocomplete, and schema validation
 * (when a `.graphqlrc` config points to your schema).
 *
 * @param path Path to the `.gql` / `.graphql` file, relative to project root
 * @returns The query string
 *
 * @example
 * ```ts
 * import { test, fromGql, configure } from "@glubean/sdk";
 *
 * const GetUser = await fromGql("./queries/getUser.gql");
 * const CreateOrder = await fromGql("./queries/createOrder.gql");
 *
 * const { graphql } = configure({
 *   graphql: { endpoint: "graphql_url" },
 * });
 *
 * export const getUser = test("get-user", async (ctx) => {
 *   const { data } = await graphql.query(GetUser, { variables: { id: "1" } });
 *   ctx.expect(data?.user.name).toBe("Alice");
 * });
 * ```
 */
export async function fromGql(path: string): Promise<string> {
  const content = await Deno.readTextFile(path);
  return content.trim();
}

// =============================================================================
// Directory loader
// =============================================================================

/**
 * Options for loading test data from a directory.
 */
export interface FromDirOptions {
  /**
   * File extensions to include.
   * Accepts a single extension or an array.
   * @default ".json"
   *
   * @example ".yaml"
   * @example [".json", ".yaml"]
   */
  ext?: string | string[];

  /**
   * When true, concatenate arrays from all files into one flat table.
   * When false (default), each file becomes one row in the table
   * with auto-injected `_name` and `_path` fields.
   *
   * @default false
   */
  concat?: boolean;

  /**
   * Dot-path to the array inside each file (JSON/YAML only).
   * Applied to every file when `concat` is true.
   *
   * @example "data"
   * @example "testCases.items"
   */
  pick?: string;

  /**
   * Recurse into subdirectories.
   * @default false
   */
  recursive?: boolean;
}

/**
 * Load test data from a directory of files.
 *
 * Supports two modes:
 *
 * - **Default mode** (`concat: false`): Each file becomes one row.
 *   The file contents are spread into the row, plus `_name` (filename
 *   without extension) and `_path` (relative path) are auto-injected.
 *
 * - **Concat mode** (`concat: true`): Each file contains an array,
 *   and all arrays are concatenated into one flat table.
 *
 * Supported file types: `.json`, `.yaml`, `.yml`, `.jsonl`, `.csv`.
 *
 * @param path Path to the directory, relative to project root
 * @param options Directory loading options
 * @returns Array of row objects
 *
 * @example One file = one test (default)
 * ```ts
 * // cases/
 * //   user-1.json  → { "id": 1, "expected": 200 }
 * //   user-999.json → { "id": 999, "expected": 404 }
 *
 * import { test, fromDir } from "@glubean/sdk";
 * export const tests = test.each(await fromDir("./cases/"))
 *   ("case-$_name", async (ctx, row) => {
 *     const res = await ctx.http.get(`${baseUrl}/users/${row.id}`);
 *     ctx.assert(res.status === row.expected, "status check");
 *   });
 * ```
 *
 * @example Multiple slices concatenated
 * ```ts
 * // batches/
 * //   batch-001.json → [{ id: 1, ... }, { id: 2, ... }]
 * //   batch-002.json → [{ id: 3, ... }, { id: 4, ... }]
 *
 * export const tests = test.each(await fromDir("./batches/", { concat: true }))
 *   ("case-$id", async (ctx, row) => { ... });
 * ```
 *
 * @example YAML directory with pick
 * ```ts
 * const data = await fromDir("./specs/", {
 *   ext: ".yaml",
 *   pick: "cases",
 *   concat: true,
 * });
 * ```
 */
export async function fromDir<
  T extends Record<string, unknown> = Record<string, unknown>
>(path: string, options?: FromDirOptions): Promise<T[]> {
  const extensions = toArray(options?.ext || ".json");
  const concat = options?.concat ?? false;
  const pick = options?.pick;
  const recursive = options?.recursive ?? false;

  // Collect matching files
  const files: string[] = [];
  await collectFiles(path, extensions, recursive, files);
  files.sort(); // Deterministic order

  if (files.length === 0) {
    return [];
  }

  if (concat) {
    // Concat mode: each file has an array, concatenate them all
    const result: T[] = [];
    for (const filePath of files) {
      const fileData = await loadFileAuto<T>(filePath, pick);
      result.push(...fileData);
    }
    return result;
  } else {
    // Default mode: each file is one row
    const result: T[] = [];
    for (const filePath of files) {
      const content = await loadSingleFileAsObject(filePath);
      const name = fileNameWithoutExt(filePath);
      const relativePath = filePath.startsWith(path)
        ? filePath.slice(path.length).replace(/^\//, "")
        : filePath;

      result.push({
        _name: name,
        _path: relativePath,
        ...content,
      } as unknown as T);
    }
    return result;
  }
}

// =============================================================================
// Internal helpers for fromDir
// =============================================================================

/**
 * Recursively collect files matching the given extensions.
 * @internal
 */
async function collectFiles(
  dir: string,
  extensions: string[],
  recursive: boolean,
  result: string[]
): Promise<void> {
  for await (const entry of Deno.readDir(dir)) {
    const fullPath = dir.endsWith("/")
      ? `${dir}${entry.name}`
      : `${dir}/${entry.name}`;

    if (entry.isFile) {
      const matchesExt = extensions.some((ext) =>
        entry.name.toLowerCase().endsWith(ext.toLowerCase())
      );
      if (matchesExt) {
        result.push(fullPath);
      }
    } else if (entry.isDirectory && recursive) {
      await collectFiles(fullPath, extensions, recursive, result);
    }
  }
}

/**
 * Load a single file as an array of rows, auto-detecting format.
 * Used in concat mode.
 * @internal
 */
async function loadFileAuto<T extends Record<string, unknown>>(
  filePath: string,
  pick?: string
): Promise<T[]> {
  const lower = filePath.toLowerCase();

  if (lower.endsWith(".csv")) {
    return (await fromCsv(filePath)) as unknown as T[];
  }

  if (lower.endsWith(".jsonl")) {
    return await fromJsonl<T>(filePath);
  }

  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) {
    return await fromYaml<T>(filePath, { pick });
  }

  // Default: JSON
  const content = await Deno.readTextFile(filePath);
  const data = JSON.parse(content);
  return extractArray<T>(data, pick, filePath);
}

/**
 * Load a single file as one object (for default fromDir mode).
 * @internal
 */
async function loadSingleFileAsObject(
  filePath: string
): Promise<Record<string, unknown>> {
  const lower = filePath.toLowerCase();
  const content = await Deno.readTextFile(filePath);

  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) {
    const data = parseYaml(content);
    if (data && typeof data === "object" && !Array.isArray(data)) {
      return data as Record<string, unknown>;
    }
    return { data };
  }

  if (lower.endsWith(".jsonl")) {
    // JSONL in single-file mode: return first line as the object
    const firstLine = content.split("\n").find((l) => l.trim() !== "");
    if (firstLine) {
      return JSON.parse(firstLine);
    }
    return {};
  }

  if (lower.endsWith(".csv")) {
    // CSV in single-file mode: return first row as the object
    const rows = await fromCsv(filePath);
    return rows[0] ?? {};
  }

  // Default: JSON
  const data = JSON.parse(content);
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  return { data };
}

/**
 * Extract filename without extension.
 * @internal
 */
function fileNameWithoutExt(filePath: string): string {
  const parts = filePath.split("/");
  const filename = parts[parts.length - 1];
  const lastDot = filename.lastIndexOf(".");
  return lastDot === -1 ? filename : filename.substring(0, lastDot);
}
