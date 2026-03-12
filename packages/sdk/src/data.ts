/**
 * Data loading utilities for test.each data-driven tests.
 *
 * These helpers load test data from various file formats and directories,
 * returning plain arrays suitable for `test.each()`.
 *
 * All paths are **relative to the project root** (the directory containing
 * `package.json`). The runner guarantees that `process.cwd()` points to the
 * project root at execution time.
 *
 * @module data
 */

import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

// =============================================================================
// Shared utilities
// =============================================================================

function safeCwd(): string {
  try {
    return process.cwd();
  } catch {
    return "(unavailable)";
  }
}

function formatPathErrorContext(
  path: string,
  action: "read file" | "read directory" | "parse JSON file",
  error: unknown,
): Error {
  const cwd = safeCwd();
  const resolvedPath = cwd === "(unavailable)" ? path : resolve(cwd, path);
  const cause = error instanceof Error ? error : undefined;
  const reason = error instanceof Error ? error.message : String(error);

  return new Error(
    `Failed to ${action}: "${path}".\n` +
      `Current working directory: ${cwd}\n` +
      `Resolved path: ${resolvedPath}\n` +
      'Hint: data loader paths are resolved from project root (where "package.json" is).\n' +
      'Hint: if your file is in the standard data folder, use a path like "./data/cases.csv".\n' +
      `Cause: ${reason}`,
    cause ? { cause } : undefined,
  );
}

async function readTextFileWithContext(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch (error) {
    throw formatPathErrorContext(path, "read file", error);
  }
}

function parseJsonWithContext(path: string, content: string): unknown {
  try {
    return JSON.parse(content);
  } catch (error) {
    throw formatPathErrorContext(path, "parse JSON file", error);
  }
}

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
 *
 * @internal
 */
function extractArray<T extends Record<string, unknown>>(
  data: unknown,
  pick: string | undefined,
  sourcePath: string,
): T[] {
  if (pick) {
    const picked = pickByPath(data, pick);
    if (!Array.isArray(picked)) {
      throw new Error(
        `${sourcePath}: pick path "${pick}" did not resolve to an array. ` +
          `Got: ${picked === undefined ? "undefined" : typeof picked}`,
      );
    }
    return picked as T[];
  }

  if (Array.isArray(data)) {
    return data as T[];
  }

  if (data && typeof data === "object" && !Array.isArray(data)) {
    const arrayFields: string[] = [];
    for (
      const [key, value] of Object.entries(
        data as Record<string, unknown>,
      )
    ) {
      if (Array.isArray(value)) {
        arrayFields.push(`"${key}" (${value.length} items)`);
      }
    }
    const hint = arrayFields.length > 0
      ? `\nFound these array fields: ${arrayFields.join(", ")}` +
        `\nHint: use { pick: "${arrayFields[0]?.match(/"([^"]+)"/)?.[1] ?? ""}" } to select one.`
      : "\nNo array fields found at the top level.";

    throw new Error(`${sourcePath}: root is an object, not an array.${hint}`);
  }

  throw new Error(`${sourcePath}: expected an array, got ${typeof data}`);
}

// =============================================================================
// CSV loader
// =============================================================================

export interface FromCsvOptions {
  headers?: boolean;
  separator?: string;
}

export async function fromCsv<
  T extends Record<string, string> = Record<string, string>,
>(path: string, options?: FromCsvOptions): Promise<T[]> {
  const content = await readTextFileWithContext(path);
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
            i++;
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

export interface FromYamlOptions {
  pick?: string;
}

export async function fromYaml<
  T extends Record<string, unknown> = Record<string, unknown>,
>(path: string, options?: FromYamlOptions): Promise<T[]> {
  const content = await readTextFileWithContext(path);
  const data = parseYaml(content);
  return extractArray<T>(data, options?.pick, path);
}

// =============================================================================
// JSONL loader
// =============================================================================

export async function fromJsonl<
  T extends Record<string, unknown> = Record<string, unknown>,
>(path: string): Promise<T[]> {
  const content = await readTextFileWithContext(path);
  const lines = content.split("\n").filter((line) => line.trim() !== "");
  return lines.map((line, index) => {
    try {
      return JSON.parse(line) as T;
    } catch {
      throw new Error(
        `${path}: invalid JSON at line ${index + 1}: ${line.substring(0, 80)}`,
      );
    }
  });
}

// =============================================================================
// Directory loader
// =============================================================================

export interface FromDirOptions {
  ext?: string | string[];
  recursive?: boolean;
}

export interface FromDirConcatOptions extends FromDirOptions {
  pick?: string;
}

export async function fromDir<
  T extends Record<string, unknown> = Record<string, unknown>,
>(path: string, options?: FromDirOptions): Promise<T[]> {
  const files = await _collectAndSort(path, options);

  if (files.length === 0) {
    return [];
  }

  const result: T[] = [];
  for (const filePath of files) {
    const content = await loadSingleFileAsObject(filePath);
    const name = fileNameWithoutExt(filePath);
    const relativePath = filePath.startsWith(path) ? filePath.slice(path.length).replace(/^\//, "") : filePath;

    result.push({
      _name: name,
      _path: relativePath,
      ...content,
    } as unknown as T);
  }
  return result;
}

fromDir.concat = async function fromDirConcat<
  T extends Record<string, unknown> = Record<string, unknown>,
>(path: string, options?: FromDirConcatOptions): Promise<T[]> {
  const files = await _collectAndSort(path, options);

  if (files.length === 0) {
    return [];
  }

  const result: T[] = [];
  for (const filePath of files) {
    const fileData = await loadFileAuto<T>(filePath, options?.pick);
    result.push(...fileData);
  }
  return result;
};

fromDir.merge = async function fromDirMerge<
  T extends Record<string, unknown> = Record<string, unknown>,
>(path: string, options?: FromDirOptions): Promise<Record<string, T>> {
  const files = await _collectAndSort(path, options);

  const result: Record<string, T> = {};
  for (const filePath of files) {
    const content = await loadSingleFileAsObject(filePath);
    Object.assign(result, content);
  }
  return result;
};

async function _collectAndSort(
  path: string,
  options?: FromDirOptions,
): Promise<string[]> {
  const extensions = toArray(options?.ext || ".json");
  const recursive = options?.recursive ?? false;
  const files: string[] = [];
  await collectFiles(path, extensions, recursive, files);
  files.sort();
  return files;
}

// =============================================================================
// Internal helpers for fromDir
// =============================================================================

async function collectFiles(
  dir: string,
  extensions: string[],
  recursive: boolean,
  result: string[],
): Promise<void> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = dir.endsWith("/") ? `${dir}${entry.name}` : `${dir}/${entry.name}`;

      if (entry.isFile()) {
        const matchesExt = extensions.some((ext) => entry.name.toLowerCase().endsWith(ext.toLowerCase()));
        if (matchesExt) {
          result.push(fullPath);
        }
      } else if (entry.isDirectory() && recursive) {
        await collectFiles(fullPath, extensions, recursive, result);
      }
    }
  } catch (error) {
    throw formatPathErrorContext(dir, "read directory", error);
  }
}

async function loadFileAuto<T extends Record<string, unknown>>(
  filePath: string,
  pick?: string,
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

  const content = await readTextFileWithContext(filePath);
  const data = parseJsonWithContext(filePath, content);
  return extractArray<T>(data, pick, filePath);
}

async function loadSingleFileAsObject(
  filePath: string,
): Promise<Record<string, unknown>> {
  const lower = filePath.toLowerCase();
  const content = await readTextFileWithContext(filePath);

  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) {
    const data = parseYaml(content);
    if (data && typeof data === "object" && !Array.isArray(data)) {
      return data as Record<string, unknown>;
    }
    return { data };
  }

  if (lower.endsWith(".jsonl")) {
    const firstLine = content.split("\n").find((l) => l.trim() !== "");
    if (firstLine) {
      return JSON.parse(firstLine);
    }
    return {};
  }

  if (lower.endsWith(".csv")) {
    const rows = await fromCsv(filePath);
    return rows[0] ?? {};
  }

  const data = JSON.parse(content);
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  return { data };
}

function fileNameWithoutExt(filePath: string): string {
  const parts = filePath.split("/");
  const filename = parts[parts.length - 1];
  const lastDot = filename.lastIndexOf(".");
  return lastDot === -1 ? filename : filename.substring(0, lastDot);
}
