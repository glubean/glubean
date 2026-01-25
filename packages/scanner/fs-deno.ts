/**
 * Deno file system implementation for the scanner.
 */

import { walk } from "@std/fs/walk";
import { join, relative } from "@std/path";
import { crypto } from "@std/crypto";
import { encodeHex } from "@std/encoding/hex";
import type { FileSystem, Hasher } from "./scanner.ts";

/**
 * Deno file system implementation.
 */
export const denoFs: FileSystem = {
  async exists(path: string): Promise<boolean> {
    try {
      await Deno.stat(path);
      return true;
    } catch {
      return false;
    }
  },

  async readText(path: string): Promise<string> {
    return await Deno.readTextFile(path);
  },

  async readBytes(path: string): Promise<Uint8Array> {
    return await Deno.readFile(path);
  },

  async *walk(
    dir: string,
    options: { extensions: string[]; skipDirs: string[] },
  ): AsyncIterable<string> {
    const skipPatterns = options.skipDirs.map(
      (d) => new RegExp(`(^|/)${d}(/|$)`),
    );

    for await (const entry of walk(dir, {
      exts: options.extensions.map((e) => e.replace(/^\./, "")),
      skip: skipPatterns,
    })) {
      if (entry.isFile) {
        yield entry.path;
      }
    }
  },

  join(...segments: string[]): string {
    return join(...(segments as [string, ...string[]]));
  },

  relative(base: string, target: string): string {
    return relative(base, target);
  },
};

/**
 * Deno hasher implementation using Web Crypto API.
 */
export const denoHasher: Hasher = {
  async sha256(content: Uint8Array): Promise<string> {
    const hashBuffer = await crypto.subtle.digest(
      "SHA-256",
      content as BufferSource,
    );
    return "sha256-" + encodeHex(new Uint8Array(hashBuffer));
  },
};
