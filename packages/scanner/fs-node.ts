/**
 * Node.js file system implementation for the scanner.
 *
 * Uses `node:` prefix for built-in modules, which is compatible with both:
 * - Node.js (direct import)
 * - Deno (via node: compatibility layer)
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { FileSystem, Hasher } from "./scanner.ts";

/**
 * Node.js file system implementation.
 */
export const nodeFs: FileSystem = {
  async exists(p: string): Promise<boolean> {
    try {
      await fs.stat(p);
      return true;
    } catch {
      return false;
    }
  },

  async readText(p: string): Promise<string> {
    return await fs.readFile(p, "utf-8");
  },

  async readBytes(p: string): Promise<Uint8Array> {
    const buffer = await fs.readFile(p);
    return new Uint8Array(buffer);
  },

  async *walk(
    dir: string,
    options: { extensions: string[]; skipDirs: string[] },
  ): AsyncIterable<string> {
    const skipSet = new Set(options.skipDirs);
    const extSet = new Set(options.extensions);

    async function* walkDir(currentDir: string): AsyncIterable<string> {
      const entries = await fs.readdir(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);

        if (entry.isDirectory()) {
          // Skip excluded directories
          if (!skipSet.has(entry.name)) {
            yield* walkDir(fullPath);
          }
        } else if (entry.isFile()) {
          // Check file extension
          const ext = path.extname(entry.name);
          if (extSet.has(ext)) {
            yield fullPath;
          }
        }
      }
    }

    yield* walkDir(dir);
  },

  join(...segments: string[]): string {
    return path.join(...segments);
  },

  relative(base: string, target: string): string {
    return path.relative(base, target);
  },

  resolve(p: string): string {
    return path.resolve(p);
  },
};

/**
 * Node.js hasher implementation using crypto module.
 */
export const nodeHasher: Hasher = {
  async sha256(content: Uint8Array): Promise<string> {
    const hash = createHash("sha256").update(content).digest("hex");
    return "sha256-" + hash;
  },
};
