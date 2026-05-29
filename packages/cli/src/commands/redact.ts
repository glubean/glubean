/**
 * `glubean redact` — Preview redaction on a result JSON file.
 *
 * Reads a .result.json file, applies the project's redaction config,
 * and writes the redacted version to stdout or a file.
 */

import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  GlubeanConfigError,
  loadProjectConfigV1,
  resolveRedactionConfig,
} from "../lib/config.js";

const colors = {
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
};

export interface RedactCommandOptions {
  input?: string;
  output?: string;
  stdout?: boolean;
  config?: string[];
}

export async function redactCommand(options: RedactCommandOptions): Promise<void> {
  const cwd = process.cwd();

  // Find input file
  const inputPath = resolve(cwd, options.input ?? "glubean-run.result.json");

  let raw: string;
  try {
    raw = await readFile(inputPath, "utf-8");
  } catch {
    console.error(`${colors.red}Could not read: ${inputPath}${colors.reset}`);
    console.error(`${colors.dim}Run tests with --result-json first, or specify a path with --input.${colors.reset}`);
    process.exit(1);
  }

  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    console.error(`${colors.red}Invalid JSON: ${inputPath}${colors.reset}`);
    process.exit(1);
  }

  if (!payload.tests || !Array.isArray(payload.tests)) {
    console.error(`${colors.red}Not a valid result file (missing tests array): ${inputPath}${colors.reset}`);
    process.exit(1);
  }

  // Resolve redaction from glubean.yaml `defaults.redaction` (config
  // consolidation — docs/06). Only a genuinely-absent config falls back to
  // the safe full-redaction default. An explicit `--config` or a
  // present-but-malformed glubean.yaml is FATAL: silently using default
  // rules could leave declared secrets (sensitiveKeys / customPatterns)
  // un-redacted in the output.
  const explicitConfig = options.config?.[0];
  const hasConfig = explicitConfig
    ? true
    : await stat(resolve(cwd, "glubean.yaml")).then(() => true).catch(() => false);
  let redaction;
  if (!hasConfig) {
    redaction = resolveRedactionConfig(undefined);
  } else {
    try {
      const { config } = await loadProjectConfigV1(
        cwd,
        explicitConfig ? { configPath: explicitConfig } : {},
      );
      redaction = resolveRedactionConfig(config.defaults?.redaction);
    } catch (err) {
      if (!(err instanceof GlubeanConfigError)) throw err;
      console.error(`${colors.red}${err.message}${colors.reset}`);
      process.exit(1);
    }
  }

  // Apply redaction
  const { compileScopes, redactEvent, BUILTIN_SCOPES } = await import("@glubean/redaction");
  const compiledScopes = compileScopes({
    builtinScopes: BUILTIN_SCOPES,
    globalRules: redaction.globalRules,
    replacementFormat: redaction.replacementFormat,
  });

  let redactionCount = 0;

  const redactedPayload = {
    ...payload,
    tests: payload.tests.map((t: any) => ({
      ...t,
      events: t.events.map((e: any) => {
        const redacted = redactEvent(e, compiledScopes, redaction.replacementFormat);
        if (JSON.stringify(redacted) !== JSON.stringify(e)) {
          redactionCount++;
        }
        return redacted;
      }),
    })),
  };

  const redactedJson = JSON.stringify(redactedPayload, null, 2);

  if (options.stdout) {
    process.stdout.write(redactedJson + "\n");
    return;
  }

  // Write to output file (default: <input>.redacted.json or overwrite input)
  const outputPath = options.output
    ? resolve(cwd, options.output)
    : inputPath.replace(/\.json$/, ".redacted.json");

  await writeFile(outputPath, redactedJson + "\n", "utf-8");

  console.log(`${colors.bold}${colors.cyan}🔒 Redaction Preview${colors.reset}`);
  console.log();
  console.log(`${colors.dim}Input:  ${inputPath}${colors.reset}`);
  console.log(`${colors.dim}Output: ${outputPath}${colors.reset}`);
  console.log(`${colors.dim}Config: ${redaction.replacementFormat} format${colors.reset}`);
  console.log();
  console.log(
    `${colors.green}✓ ${redactionCount} event(s) redacted across ${payload.tests.length} test(s)${colors.reset}`,
  );
}
