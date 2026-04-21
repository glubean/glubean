/**
 * @module install-plugin
 *
 * Plugin manifest installation driver — the single entry point for plugin-level
 * global registration. Builds on top of the low-level primitives
 * (`Expectation.extend`, `contract.register`) to provide:
 *
 * - **Plugin identity** — every manifest has a `name`, tracked for diagnostics.
 * - **Conflict detection** — duplicate matcher/protocol names across plugins
 *   throw with messages that name both plugins.
 * - **Idempotent install** — re-installing the same plugin (by `name`) is a no-op.
 * - **Install-order hooks** — `setup()` runs after matchers/contracts are registered.
 *
 * `installPlugin` is the recommended surface for plugin authors. The primitives
 * (`Expectation.extend`, `contract.register`) remain public for inline patching
 * or prototyping, but bypass identity tracking and conflict detection.
 *
 * @see {@link PluginManifest} in `./types.js`
 */

import type { PluginManifest } from "./types.js";
import { Expectation } from "./expect.js";
import { contract } from "./contract-core.js";

/**
 * Registry of installed plugins, keyed by manifest `name`.
 * Used for duplicate detection and `listInstalledPlugins()`.
 * @internal
 */
const installed = new Map<string, PluginManifest>();

/**
 * Reverse index: which plugin registered which matcher name?
 * Used for conflict error messages. Keyed by matcher name → plugin name.
 * @internal
 */
const matcherOwners = new Map<string, string>();

/**
 * Reverse index: which plugin registered which protocol name?
 * Keyed by protocol name → plugin name.
 * @internal
 */
const protocolOwners = new Map<string, string>();

/**
 * Install one or more plugin manifests. Drives registration in strict order:
 *
 * 1. For each plugin in the order given, register all its matchers
 * 2. Then register all its contracts
 * 3. Then run its `setup()` (if present, awaited)
 * 4. Record it in the installed-plugins registry
 *
 * Subsequent calls with an already-installed plugin (same `name`) are no-ops.
 * Cross-plugin name collisions (matcher or protocol) throw, with an error
 * message that names both the existing owner and the incoming plugin.
 *
 * @param plugins One or more manifests to install, in order.
 *
 * @example
 * ```ts
 * import { installPlugin } from "@glubean/sdk";
 * import graphqlPlugin from "@glubean/graphql";
 * import grpcPlugin from "@glubean/grpc";
 *
 * await installPlugin(graphqlPlugin, grpcPlugin);
 * ```
 */
export async function installPlugin(
  ...plugins: PluginManifest[]
): Promise<void> {
  for (const plugin of plugins) {
    if (!plugin || typeof plugin !== "object" || typeof plugin.name !== "string") {
      throw new Error(
        "installPlugin: expected a PluginManifest with a string `name` field. " +
          `Got: ${typeof plugin === "object" ? JSON.stringify(plugin) : typeof plugin}.`,
      );
    }

    if (installed.has(plugin.name)) {
      // Idempotent: re-install is a no-op. Surface a quiet warning so developers
      // can spot accidental double-installs during hot-reload / test iteration.
      if (typeof process !== "undefined" && process.env?.["GLUBEAN_DEBUG"]) {
        process.stderr.write(
          `[glubean:debug] installPlugin: skipping duplicate install of "${plugin.name}"\n`,
        );
      }
      continue;
    }

    // --- Matchers ---------------------------------------------------------
    if (plugin.matchers) {
      for (const [name, fn] of Object.entries(plugin.matchers)) {
        const existingOwner = matcherOwners.get(name);
        if (existingOwner) {
          throw new Error(
            `installPlugin("${plugin.name}"): matcher "${name}" is already registered ` +
              `by plugin "${existingOwner}". ` +
              `Each matcher name can only be owned by one plugin.`,
          );
        }
        // Expectation.extend does its own "already exists" check against the
        // prototype (covers inline patches that bypass installPlugin). It
        // throws on conflict, which we let propagate.
        Expectation.extend({ [name]: fn });
        matcherOwners.set(name, plugin.name);
      }
    }

    // --- Contracts --------------------------------------------------------
    if (plugin.contracts) {
      for (const [protocol, adapter] of Object.entries(plugin.contracts)) {
        const existingOwner = protocolOwners.get(protocol);
        if (existingOwner) {
          throw new Error(
            `installPlugin("${plugin.name}"): protocol "${protocol}" is already registered ` +
              `by plugin "${existingOwner}". ` +
              `Each protocol name can only be owned by one plugin.`,
          );
        }
        // Note: contract.register currently has no built-in duplicate check
        // — our reverse index above is the only guard against plugin-level
        // conflicts. Inline `contract.register` usage (bypassing installPlugin)
        // will silently overwrite; document this limitation.
        contract.register(protocol, adapter as Parameters<typeof contract.register>[1]);
        protocolOwners.set(protocol, plugin.name);
      }
    }

    // --- Setup hook -------------------------------------------------------
    if (plugin.setup) {
      await plugin.setup();
    }

    installed.set(plugin.name, plugin);
  }
}

/**
 * Return a snapshot array of all currently installed plugin manifests, in
 * install order. Useful for diagnostics, debug tools, and MCP metadata export.
 *
 * The returned array is a shallow copy — mutating it does not affect the
 * installed state. Manifest objects themselves are returned by reference.
 */
export function listInstalledPlugins(): PluginManifest[] {
  return [...installed.values()];
}

/**
 * Clear all installed-plugin bookkeeping. **Test-only.** Does **not** unregister
 * matchers from `Expectation.prototype` or protocols from the contract registry
 * — those are permanent once installed.
 *
 * Intended for test suites that install plugins and need to reset the tracking
 * maps between test cases.
 *
 * @internal
 */
export function __resetInstalledPluginsForTesting(): void {
  installed.clear();
  matcherOwners.clear();
  protocolOwners.clear();
}
