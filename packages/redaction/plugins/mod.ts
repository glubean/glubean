/**
 * @module plugins
 *
 * Re-exports all built-in plugins and provides `createBuiltinPlugins()`
 * factory that assembles the plugin list from a RedactionConfig.
 */

import type { RedactionConfig, RedactionPlugin } from "../types";
import { sensitiveKeysPlugin } from "./sensitive-keys";
import { jwtPlugin } from "./jwt";
import { bearerPlugin } from "./bearer";
import { awsKeysPlugin } from "./aws-keys";
import { githubTokensPlugin } from "./github-tokens";
import { emailPlugin } from "./email";
import { ipAddressPlugin } from "./ip-address";
import { creditCardPlugin } from "./credit-card";
import { hexKeysPlugin } from "./hex-keys";

export {
  sensitiveKeysPlugin,
  jwtPlugin,
  bearerPlugin,
  awsKeysPlugin,
  githubTokensPlugin,
  emailPlugin,
  ipAddressPlugin,
  creditCardPlugin,
  hexKeysPlugin,
};

/** Map of pattern name → plugin for built-in patterns. */
const PATTERN_PLUGINS: Record<string, RedactionPlugin> = {
  jwt: jwtPlugin,
  bearer: bearerPlugin,
  awsKeys: awsKeysPlugin,
  githubTokens: githubTokensPlugin,
  email: emailPlugin,
  ipAddress: ipAddressPlugin,
  creditCard: creditCardPlugin,
  hexKeys: hexKeysPlugin,
};

/**
 * Create the full plugin list from a RedactionConfig.
 *
 * Order: sensitive-keys plugin first (key-level), then enabled pattern
 * plugins (value-level), then user custom patterns.
 *
 * @example
 * const plugins = createBuiltinPlugins(DEFAULT_CONFIG);
 * const engine = new RedactionEngine({ config: DEFAULT_CONFIG, plugins });
 */
export function createBuiltinPlugins(
  config: RedactionConfig
): RedactionPlugin[] {
  const plugins: RedactionPlugin[] = [];

  // Key-level plugin always first
  plugins.push(sensitiveKeysPlugin(config.sensitiveKeys));

  // Add enabled pattern plugins
  const patternFlags = config.patterns as unknown as Record<string, unknown>;
  for (const [name, plugin] of Object.entries(PATTERN_PLUGINS)) {
    if (patternFlags[name] === true) {
      plugins.push(plugin);
    }
  }

  // Add user custom patterns
  for (const custom of config.patterns.custom ?? []) {
    try {
      // Validate regex compiles
      new RegExp(custom.regex, "g");
      plugins.push({
        name: custom.name,
        matchValue: () => new RegExp(custom.regex, "g"),
      });
    } catch {
      // Skip invalid regex patterns — per arch doc, CLI warns but doesn't abort
    }
  }

  return plugins;
}
