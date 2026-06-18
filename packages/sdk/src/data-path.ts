import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export type DataPathMode = "file" | "project" | "absolute";

export interface ResolveDataPathOptions {
  /**
   * Absolute path to the project root.
   * Used for bare paths and as a fallback when the caller cannot be found.
   */
  projectRoot: string;
  /**
   * Absolute path to the calling source file.
   * Only needed for `./` / `../` paths.
   */
  callerFile?: string;
}

export interface ResolvedDataPath {
  mode: DataPathMode;
  resolvedPath: string;
}

const INTERNAL_FRAME_FILE_NAMES = new Set([
  "data.ts",
  "data.js",
  "data-path.ts",
  "data-path.js",
  // load/feeder.ts delegates to the data loaders, so it must be transparent for
  // caller-relative path resolution (otherwise `./` paths resolve next to the
  // feeder wrapper instead of the user's module).
  "feeder.ts",
  "feeder.js",
]);

/**
 * Classify a user-supplied path into one of the supported resolution modes.
 */
export function classifyDataPath(rawPath: string): DataPathMode {
  if (isAbsolute(rawPath)) return "absolute";
  if (rawPath.startsWith("./") || rawPath.startsWith("../")) return "file";
  return "project";
}

function preserveTrailingSlash(rawPath: string, resolvedPath: string): string {
  if (rawPath.endsWith("/") && !resolvedPath.endsWith("/")) {
    return `${resolvedPath}/`;
  }
  return resolvedPath;
}

/**
 * Resolve a data-loader path using the Glubean path contract.
 *
 * - `./` and `../` are resolved relative to the calling file
 * - bare paths are resolved relative to the project root
 * - absolute paths are preserved
 */
export function resolveDataPath(
  rawPath: string,
  options: ResolveDataPathOptions,
): ResolvedDataPath {
  const mode = classifyDataPath(rawPath);

  if (mode === "absolute") {
    return { mode, resolvedPath: preserveTrailingSlash(rawPath, rawPath) };
  }

  if (mode === "project") {
    return {
      mode,
      resolvedPath: preserveTrailingSlash(
        rawPath,
        resolve(options.projectRoot, rawPath),
      ),
    };
  }

  const callerFile = options.callerFile ?? findCallerFilePath();
  const baseDir = callerFile ? dirname(callerFile) : options.projectRoot;
  return {
    mode,
    resolvedPath: preserveTrailingSlash(rawPath, resolve(baseDir, rawPath)),
  };
}

/**
 * Find the first stack frame outside the SDK package and return its file path.
 *
 * This is intentionally isolated in one helper so the stack parsing hack stays
 * contained to the file-relative path mode.
 */
export function findCallerFilePath(): string | undefined {
  try {
    const stack = new Error().stack;
    if (!stack) return undefined;

    const thisFile = fileURLToPath(import.meta.url);
    const internalDir = dirname(thisFile);
    const lines = stack.split("\n");

    for (const line of lines) {
      const fileUrlMatch = line.match(/\(?file:\/\/\/(.*?):\d+:\d+\)?/);
      const plainPathMatch = !fileUrlMatch && line.match(/\(?(\/[^:]+):\d+:\d+\)?/);
      const match = fileUrlMatch || plainPathMatch;
      if (!match) continue;

      let framePath: string;
      try {
        framePath = fileUrlMatch
          ? fileURLToPath(`file:///${match[1]}`)
          : match[1];
      } catch {
        continue;
      }

      if (framePath === thisFile) continue;
      // Skip known SDK-internal loader frames anywhere under the package dir
      // (e.g. `data.ts` at the root, `load/feeder.ts` in a subdir). Restricted
      // to specific basenames so co-located `*.test.ts` files are NOT skipped.
      if (
        framePath.startsWith(internalDir + sep) &&
        INTERNAL_FRAME_FILE_NAMES.has(basename(framePath))
      ) {
        continue;
      }
      if (framePath.includes("@glubean/sdk/")) continue;
      if (framePath.includes("/node_modules/")) continue;

      return existsSync(framePath) ? framePath : undefined;
    }
  } catch {
    return undefined;
  }

  return undefined;
}
