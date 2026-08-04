import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  resolveExtensionPagePath,
  resolveUnpackedExtension,
  resolveUnpackedExtensions,
} from "./manifest.js";

const fixture = fileURLToPath(new URL("./fixtures/extension", import.meta.url));

describe("resolveUnpackedExtension", () => {
  it("resolves a directory and reads its manifest", () => {
    const extension = resolveUnpackedExtension(fixture);

    expect(extension.path).toBe(fixture);
    expect(extension.manifestPath).toBe(join(fixture, "manifest.json"));
    expect(extension.manifest.name).toBe("Glubean Extension Fixture");
    expect(extension.manifest.manifest_version).toBe(3);
  });

  it("accepts one or more extension directories and deduplicates them", () => {
    expect(resolveUnpackedExtensions(fixture)).toHaveLength(1);
    expect(resolveUnpackedExtensions([fixture, fixture])).toHaveLength(1);
  });

  it("deduplicates the same extension reached through a symlink", () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "glubean-extension-manifest-"));
    const linkedPath = join(tempDirectory, "extension-link");
    symlinkSync(fixture, linkedPath, process.platform === "win32" ? "junction" : "dir");
    try {
      expect(resolveUnpackedExtensions([fixture, linkedPath])).toHaveLength(1);
    } finally {
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  it("fails before launch when the directory is invalid", () => {
    expect(() => resolveUnpackedExtension(join(fixture, "missing"))).toThrow(
      "does not exist",
    );
    expect(() => resolveUnpackedExtensions([])).toThrow(
      "At least one Chrome extension directory is required",
    );
  });

  it("resolves options and side panel paths from the manifest", () => {
    const extension = resolveUnpackedExtension(fixture);

    expect(resolveExtensionPagePath(extension, "options")).toBe("options.html");
    expect(resolveExtensionPagePath(extension, "sidepanel")).toBe("sidepanel.html");
  });
});
