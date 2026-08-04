import { readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export interface ChromeExtensionManifest {
  manifest_version: 2 | 3;
  name: string;
  version: string;
  options_page?: string;
  options_ui?: {
    page?: string;
    open_in_tab?: boolean;
    [key: string]: unknown;
  };
  action?: {
    default_popup?: string;
    [key: string]: unknown;
  };
  background?: {
    service_worker?: string;
    page?: string;
    scripts?: string[];
    [key: string]: unknown;
  };
  side_panel?: {
    default_path?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface UnpackedExtension {
  path: string;
  manifestPath: string;
  manifest: ChromeExtensionManifest;
}

/** Resolve and validate a Chrome unpacked extension directory. */
export function resolveUnpackedExtension(extensionPath: string): UnpackedExtension {
  if (!extensionPath.trim()) {
    throw new Error("Chrome extension path must not be empty.");
  }

  const requestedPath = resolve(extensionPath);
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(requestedPath);
  } catch {
    throw new Error(`Chrome extension directory does not exist: ${requestedPath}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`Chrome extension path is not a directory: ${requestedPath}`);
  }
  const path = realpathSync(requestedPath);

  const manifestPath = join(path, "manifest.json");
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
  } catch {
    throw new Error(`Chrome extension manifest.json is missing or invalid: ${manifestPath}`);
  }

  if (!isChromeExtensionManifest(manifest)) {
    throw new Error(
      `Chrome extension manifest.json must declare manifest_version (2 or 3), name, and version: ${manifestPath}`,
    );
  }

  return { path, manifestPath, manifest };
}

export function resolveUnpackedExtensions(
  extensionPaths: string | readonly string[],
): UnpackedExtension[] {
  const paths = typeof extensionPaths === "string" ? [extensionPaths] : extensionPaths;
  if (paths.length === 0) {
    throw new Error("At least one Chrome extension directory is required.");
  }
  const extensions = paths.map(resolveUnpackedExtension);
  return [...new Map(
    extensions.map((extension) => [extension.path, extension]),
  ).values()];
}

export type ExtensionPageKind = "options" | "sidepanel";

/** Resolve an options or side-panel HTML path declared by the manifest. */
export function resolveExtensionPagePath(
  extension: UnpackedExtension,
  kind: ExtensionPageKind,
): string {
  const path = kind === "options"
    ? extension.manifest.options_ui?.page ?? extension.manifest.options_page
    : extension.manifest.side_panel?.default_path;

  if (typeof path !== "string" || path.trim() === "") {
    const declaration = kind === "options"
      ? "options_ui.page or options_page"
      : "side_panel.default_path";
    throw new Error(
      `Chrome extension manifest does not declare ${declaration}: ${extension.manifestPath}`,
    );
  }

  return path.replace(/^\/+/, "");
}

function isChromeExtensionManifest(value: unknown): value is ChromeExtensionManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Record<string, unknown>;
  return (
    (manifest.manifest_version === 2 || manifest.manifest_version === 3) &&
    typeof manifest.name === "string" &&
    manifest.name.length > 0 &&
    typeof manifest.version === "string" &&
    manifest.version.length > 0
  );
}
