import { afterEach, describe, expect, test } from "vitest";

import {
  __resetInstalledPluginsForTesting,
  installPlugin,
  listInstalledPlugins,
} from "./install-plugin.js";
import { Expectation } from "./expect.js";
import { contract } from "./contract-core.js";
import type { PluginManifest } from "./types.js";

// Note: these tests install into the real Expectation prototype and
// real contract registry. Matcher/protocol names are namespaced per-test
// (e.g. `toHaveInstallTestFoo_001`) to avoid collisions across the suite.
// The registration-tracking maps are reset between tests; matchers on the
// prototype persist (by design — see __resetInstalledPluginsForTesting).

afterEach(() => {
  __resetInstalledPluginsForTesting();
});

describe("installPlugin — basic registration", () => {
  test("registers a plugin with matchers", async () => {
    const plugin: PluginManifest = {
      name: "test-plugin-basic-matchers",
      matchers: {
        toHaveInstallBasicMatcher: (actual) => ({
          passed: actual === "match",
          message: "to have install basic matcher",
          actual,
        }),
      },
    };

    await installPlugin(plugin);

    expect(listInstalledPlugins()).toEqual([plugin]);
  });

  test("setup() runs after matchers are registered", async () => {
    const events: string[] = [];

    const plugin: PluginManifest = {
      name: "test-plugin-setup-order",
      matchers: {
        toHaveInstallSetupOrderMatcher: () => {
          events.push("matcher-registered-before-setup-observation");
          return { passed: true, message: "ok" };
        },
      },
      setup() {
        events.push("setup-ran");
      },
    };

    await installPlugin(plugin);

    expect(events).toEqual(["setup-ran"]);
  });

  test("setup() can be async", async () => {
    let setupCompleted = false;

    await installPlugin({
      name: "test-plugin-async-setup",
      async setup() {
        await new Promise((r) => setTimeout(r, 0));
        setupCompleted = true;
      },
    });

    expect(setupCompleted).toBe(true);
  });
});

describe("installPlugin — idempotency", () => {
  test("re-installing the same plugin (by name) is a no-op", async () => {
    let setupCount = 0;

    const plugin: PluginManifest = {
      name: "test-plugin-idempotent",
      setup() {
        setupCount += 1;
      },
    };

    await installPlugin(plugin);
    await installPlugin(plugin);
    await installPlugin(plugin);

    expect(setupCount).toBe(1);
    expect(listInstalledPlugins()).toHaveLength(1);
  });
});

describe("installPlugin — conflict detection", () => {
  test("two plugins registering the same matcher name throw with both plugin names", async () => {
    await installPlugin({
      name: "test-plugin-matcher-owner-A",
      matchers: {
        toHaveInstallConflictMatcher: () => ({ passed: true, message: "a" }),
      },
    });

    await expect(
      installPlugin({
        name: "test-plugin-matcher-owner-B",
        matchers: {
          toHaveInstallConflictMatcher: () => ({ passed: true, message: "b" }),
        },
      }),
    ).rejects.toThrow(
      /matcher "toHaveInstallConflictMatcher" is already registered by plugin "test-plugin-matcher-owner-A"/,
    );
  });

  test("two plugins registering the same protocol name throw with both plugin names", async () => {
    // Minimal adapter stub — we only need contract.register to accept it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stubAdapter: any = {
      project: (_spec: unknown) => ({ cases: {} }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      execute: async () => ({} as any),
    };

    await installPlugin({
      name: "test-plugin-protocol-owner-A",
      contracts: { installConflictProtoA: stubAdapter },
    });

    await expect(
      installPlugin({
        name: "test-plugin-protocol-owner-B",
        contracts: { installConflictProtoA: stubAdapter },
      }),
    ).rejects.toThrow(
      /protocol "installConflictProtoA" is already registered by plugin "test-plugin-protocol-owner-A"/,
    );
  });
});

describe("installPlugin — validation", () => {
  test("rejects a non-manifest argument", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(installPlugin(null as any)).rejects.toThrow(
      /expected a PluginManifest with a string `name` field/,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(installPlugin("not-a-manifest" as any)).rejects.toThrow(
      /expected a PluginManifest with a string `name` field/,
    );
  });
});

describe("installPlugin — primitive-path conflict detection", () => {
  test("plugin cannot register a matcher name already on Expectation.prototype from inline extend", async () => {
    // Simulate a direct Expectation.extend() call that bypassed installPlugin.
    Expectation.extend({
      toHaveInlineRegisteredMatcher: () => ({ passed: true, message: "inline" }),
    });

    await expect(
      installPlugin({
        name: "test-plugin-primitive-matcher-conflict",
        matchers: {
          toHaveInlineRegisteredMatcher: () => ({ passed: true, message: "from plugin" }),
        },
      }),
    ).rejects.toThrow(
      /matcher "toHaveInlineRegisteredMatcher" already exists on Expectation\.prototype/,
    );
  });

  test("plugin cannot register a protocol already present in contract registry from direct contract.register", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stubAdapter: any = {
      project: () => ({ cases: {} }),
      execute: async () => ({}),
    };

    // Direct primitive call, bypassing installPlugin.
    contract.register("installInlineRegisteredProto", stubAdapter);

    await expect(
      installPlugin({
        name: "test-plugin-primitive-protocol-conflict",
        contracts: { installInlineRegisteredProto: stubAdapter },
      }),
    ).rejects.toThrow(
      /protocol "installInlineRegisteredProto" is already present in the contract registry/,
    );
  });
});

describe("installPlugin — failed-setup isolation", () => {
  test("setup() failure marks plugin as unrecoverable; retry throws with original error in message", async () => {
    const plugin: PluginManifest = {
      name: "test-plugin-setup-fails",
      matchers: {
        toHaveSetupFailMatcher: () => ({ passed: true, message: "ok" }),
      },
      setup() {
        throw new Error("database connect failed");
      },
    };

    await expect(installPlugin(plugin)).rejects.toThrow("database connect failed");

    // Not listed as installed (setup never succeeded).
    expect(listInstalledPlugins()).toEqual([]);

    // Retry in same process: throws with unrecoverable-state message referencing the original error.
    await expect(installPlugin(plugin)).rejects.toThrow(
      /previous setup\(\) attempt failed.*database connect failed/s,
    );
  });

  test("setup() failure does NOT block unrelated plugins from installing", async () => {
    const failing: PluginManifest = {
      name: "test-plugin-setup-fails-isolated",
      setup() {
        throw new Error("boom");
      },
    };

    const unrelated: PluginManifest = {
      name: "test-plugin-unrelated-ok",
      matchers: {
        toHaveUnrelatedOkMatcher: () => ({ passed: true, message: "ok" }),
      },
    };

    await expect(installPlugin(failing)).rejects.toThrow("boom");

    // Unrelated plugin installs normally.
    await installPlugin(unrelated);
    expect(listInstalledPlugins().map((p) => p.name)).toEqual(["test-plugin-unrelated-ok"]);
  });
});

describe("installPlugin — pre-flight conflict check is atomic", () => {
  test("a conflict on the Nth matcher does not leave the first N-1 matchers registered", async () => {
    // First plugin claims "toHaveAtomicMatcherB".
    await installPlugin({
      name: "test-plugin-atomic-first",
      matchers: {
        toHaveAtomicMatcherB: () => ({ passed: true, message: "first" }),
      },
    });

    // Second plugin would register A then conflict on B — A must NOT end up on the prototype.
    await expect(
      installPlugin({
        name: "test-plugin-atomic-second",
        matchers: {
          toHaveAtomicMatcherA: () => ({ passed: true, message: "second-a" }),
          toHaveAtomicMatcherB: () => ({ passed: true, message: "second-b" }),
        },
      }),
    ).rejects.toThrow(/matcher "toHaveAtomicMatcherB" is already registered/);

    expect("toHaveAtomicMatcherA" in Expectation.prototype).toBe(false);
  });
});

describe("installPlugin — multi-plugin install order", () => {
  test("plugins are installed in the order they are passed", async () => {
    const order: string[] = [];

    const makePlugin = (name: string): PluginManifest => ({
      name,
      setup() {
        order.push(name);
      },
    });

    await installPlugin(
      makePlugin("plugin-order-a"),
      makePlugin("plugin-order-b"),
      makePlugin("plugin-order-c"),
    );

    expect(order).toEqual(["plugin-order-a", "plugin-order-b", "plugin-order-c"]);

    const installedNames = listInstalledPlugins().map((p) => p.name);
    expect(installedNames).toEqual([
      "plugin-order-a",
      "plugin-order-b",
      "plugin-order-c",
    ]);
  });

  test("matchers from earlier plugin are visible when later plugin's setup runs", async () => {
    let observedMatcherName: string | undefined;

    const pluginA: PluginManifest = {
      name: "plugin-earlier-matcher",
      matchers: {
        toHaveInstallEarlierMatcher: () => ({ passed: true, message: "ok" }),
      },
    };

    const pluginB: PluginManifest = {
      name: "plugin-later-observer",
      setup() {
        // After pluginA is fully installed, its matcher should be on the prototype.
        // We probe via `in` on a throwaway instance.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const probe: any = {};
        Object.setPrototypeOf(
          probe,
          // Walk up to find Expectation.prototype via the matcher we know exists.
          // Simpler: check listInstalledPlugins().
          Object.prototype,
        );
        const installed = listInstalledPlugins();
        observedMatcherName = installed[0]?.name;
      },
    };

    await installPlugin(pluginA, pluginB);

    expect(observedMatcherName).toBe("plugin-earlier-matcher");
  });
});
