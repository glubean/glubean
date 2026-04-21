/**
 * @module install-plugin
 *
 * Plugin manifest installation driver — the single entry point for plugin-level
 * global registration. Builds on top of the low-level primitives
 * (`Expectation.extend`, `contract.register`) to provide:
 *
 * - **Plugin identity** — every manifest has a `name`, tracked for diagnostics.
 * - **Conflict detection** — duplicate matcher/protocol names throw, whether the
 *   prior registration was from another plugin manifest or from a direct call
 *   to the low-level primitive.
 * - **Idempotent install** — re-installing the same plugin (by `name`) is a no-op.
 * - **Failed-setup isolation** — if a plugin's `setup()` throws, the plugin is
 *   marked as setup-failed; retrying the same plugin in the same process raises
 *   a clear error rather than silently re-registering matchers/contracts.
 * - **Install-order hooks** — `setup()` runs after matchers/contracts are registered.
 *
 * `installPlugin` is the recommended surface for plugin authors. The primitives
 * (`Expectation.extend`, `contract.register`) remain public for inline patching
 * or prototyping. `installPlugin` still detects collisions against them — a
 * plugin trying to register a matcher/protocol that a direct primitive call
 * already owns will throw.
 *
 * @see {@link PluginManifest} in `./types.js`
 */

import type { PluginManifest } from "./types.js";
import { Expectation } from "./expect.js";
import { contract, getAdapter, __unregisterProtocolForTesting } from "./contract-core.js";

/**
 * Registry of fully installed plugins (matchers + contracts + setup all
 * succeeded), keyed by manifest `name`. Feeds `listInstalledPlugins()`.
 * @internal
 */
const installed = new Map<string, PluginManifest>();

/**
 * Plugins whose `setup()` threw. Matchers/contracts they registered remain
 * on the globals (irreversible), but the plugin is NOT in `installed`.
 * Retrying such a plugin in the same process throws immediately.
 * @internal
 */
const setupFailures = new Map<string, Error>();

/**
 * Reverse index: which plugin owns which matcher name?
 * Keyed by matcher name → plugin name.
 * @internal
 */
const matcherOwners = new Map<string, string>();

/**
 * Reverse index: which plugin owns which protocol name?
 * Keyed by protocol name → plugin name.
 * @internal
 */
const protocolOwners = new Map<string, string>();

/**
 * Install one or more plugin manifests. Drives registration in strict order:
 *
 * 1. Validate the manifest shape.
 * 2. Check each matcher/protocol name for conflicts (both across plugins and
 *    against direct primitive registrations). Throws on first conflict.
 * 3. Register all matchers via `Expectation.extend`.
 * 4. Register all contracts via `contract.register`.
 * 5. Run `setup()` if present (awaited).
 * 6. Record the plugin in the installed registry.
 *
 * Subsequent calls with an already-installed plugin (same `name`) are no-ops.
 * Subsequent calls with a previously-setup-failed plugin throw.
 *
 * **Failure semantics**: if `setup()` throws, the process is left in a
 * partially-initialized state (matchers/contracts from this plugin are on
 * the globals but `installed` does not list the plugin). This state is
 * **not recoverable within the same process** — the only clean remedy is to
 * restart. Retrying the same plugin raises a clear error instead of silently
 * re-registering.
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

    // Fast-path: successful re-install is idempotent.
    if (installed.has(plugin.name)) {
      if (typeof process !== "undefined" && process.env?.["GLUBEAN_DEBUG"]) {
        process.stderr.write(
          `[glubean:debug] installPlugin: skipping duplicate install of "${plugin.name}"\n`,
        );
      }
      continue;
    }

    // Failed-setup path: matchers/contracts from a prior failed attempt are
    // still on the globals, so re-registering them would double-register.
    // Throw with full context rather than silently continuing.
    const prevFailure = setupFailures.get(plugin.name);
    if (prevFailure) {
      throw new Error(
        `installPlugin("${plugin.name}"): previous setup() attempt failed in this process ` +
          `and left matchers/contracts partially registered. This state is not recoverable — ` +
          `restart the process to retry. Original error: ${prevFailure.message}`,
      );
    }

    // --- Pre-flight conflict checks --------------------------------------
    // Done BEFORE any mutation so a conflict on the Nth matcher doesn't leave
    // the first N-1 matchers on the prototype.

    if (plugin.matchers) {
      for (const name of Object.keys(plugin.matchers)) {
        const existingOwner = matcherOwners.get(name);
        if (existingOwner) {
          throw new Error(
            `installPlugin("${plugin.name}"): matcher "${name}" is already registered ` +
              `by plugin "${existingOwner}". ` +
              `Each matcher name can only be owned by one plugin.`,
          );
        }
        // Catch matchers registered via a direct `Expectation.extend()` call
        // that bypassed installPlugin. Expectation.extend itself would throw
        // when we try to register, but with a generic message — pre-check so
        // the error names the plugin that's trying to register.
        if (name in Expectation.prototype) {
          throw new Error(
            `installPlugin("${plugin.name}"): matcher "${name}" already exists on Expectation.prototype ` +
              `(likely registered by a direct Expectation.extend() call or a built-in matcher). ` +
              `Matcher names must be unique across the entire process.`,
          );
        }
      }
    }

    if (plugin.contracts) {
      for (const protocol of Object.keys(plugin.contracts)) {
        const existingOwner = protocolOwners.get(protocol);
        if (existingOwner) {
          throw new Error(
            `installPlugin("${plugin.name}"): protocol "${protocol}" is already registered ` +
              `by plugin "${existingOwner}". ` +
              `Each protocol name can only be owned by one plugin.`,
          );
        }
        // Catch protocols registered via a direct `contract.register()` call
        // that bypassed installPlugin. Unlike Expectation.extend, the current
        // contract.register has no built-in duplicate guard — it would
        // silently overwrite the live adapter. Pre-check via getAdapter().
        if (getAdapter(protocol)) {
          throw new Error(
            `installPlugin("${plugin.name}"): protocol "${protocol}" is already present in the contract registry ` +
              `(likely registered by a direct contract.register() call). ` +
              `Protocol names must be unique across the entire process.`,
          );
        }
      }
    }

    // --- Mutations (past this point, prototype/registry get modified) ----

    if (plugin.matchers) {
      for (const [name, fn] of Object.entries(plugin.matchers)) {
        Expectation.extend({ [name]: fn });
        matcherOwners.set(name, plugin.name);
      }
    }

    if (plugin.contracts) {
      for (const [protocol, adapter] of Object.entries(plugin.contracts)) {
        contract.register(protocol, adapter as Parameters<typeof contract.register>[1]);
        protocolOwners.set(protocol, plugin.name);
      }
    }

    // --- Setup hook (failure leaves partial state) -----------------------

    if (plugin.setup) {
      try {
        await plugin.setup();
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setupFailures.set(plugin.name, error);
        throw error;
      }
    }

    installed.set(plugin.name, plugin);
  }
}

/**
 * Return a snapshot array of all successfully installed plugin manifests, in
 * install order. Plugins whose `setup()` threw are **not** included.
 *
 * The returned array is a shallow copy — mutating it does not affect the
 * installed state. Manifest objects themselves are returned by reference.
 */
export function listInstalledPlugins(): PluginManifest[] {
  return [...installed.values()];
}

/**
 * Clear all installed-plugin state. **Test-only.**
 *
 * Performs a **true reset**:
 *   1. Unregisters every matcher previously installed via a plugin manifest
 *      from `Expectation.prototype`.
 *   2. Unregisters every protocol adapter previously installed via a plugin
 *      manifest from the contract registry (`_adapters` + `contract[protocol]`).
 *   3. Clears all internal tracking maps (`installed`, `matcherOwners`,
 *      `protocolOwners`, `setupFailures`).
 *
 * **Scope limits:**
 * - Only touches registrations introduced via `installPlugin`. Matchers /
 *   protocols registered via a direct call to the primitive (bypassing
 *   `installPlugin`) are **not** tracked by the owner maps and therefore
 *   will not be removed.
 * - Built-in Expectation matchers (defined on the class body, not added
 *   via `extend()`) are unaffected because `delete` on a class-syntax
 *   method is a no-op.
 *
 * Intended for test suites that install plugins, need to simulate a
 * fresh process, and then install again.
 *
 * @internal
 */
export function __resetInstalledPluginsForTesting(): void {
  for (const [name] of matcherOwners) {
    Expectation.__removeMatcherForTesting(name);
  }
  for (const [protocol] of protocolOwners) {
    __unregisterProtocolForTesting(protocol);
  }
  installed.clear();
  matcherOwners.clear();
  protocolOwners.clear();
  setupFailures.clear();
}
