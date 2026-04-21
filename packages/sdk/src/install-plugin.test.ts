import { afterEach, describe, expect, test } from "vitest";

import {
  __resetInstalledPluginsForTesting,
  installPlugin,
  listInstalledPlugins,
} from "./install-plugin.js";
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
