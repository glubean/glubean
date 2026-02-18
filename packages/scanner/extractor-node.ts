import type { ExportMeta } from "./types.ts";

/**
 * Node.js metadata extractor stub.
 *
 * This is a placeholder for non-Deno runtimes. It intentionally throws to
 * signal that a Node-compatible extractor must be supplied by the caller.
 */
export function extractWithNode(
  _filePath: string,
): Promise<ExportMeta[]> {
  return Promise.reject(
    new Error(
      "Node extractor not implemented. Provide a runtime-specific extractor " +
        "to Scanner or use createScanner() in Deno.",
    ),
  );
}
