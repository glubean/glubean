/**
 * Resolved plan printer — emits a human-readable summary of the
 * ResolvedRunPlan that the CLI will execute. Per `04-config-profiles-
 * public-demo-plan.zh.md` §"可见 plan 输出", the output must be a
 * product-grade signal (not debug noise): users need to see exactly
 * what profile + suites + selection + execution + reporters are in
 * effect from the first screen of any CI log.
 *
 * Pure formatting: no I/O, no env reads, no console.log. Caller is
 * responsible for piping `formatResolvedPlan(...)` to the user-visible
 * stream and for picking up CLI-overridden fields (this formatter
 * trusts that the ResolvedRunPlan it receives is already the post-
 * override view).
 */

import { relative } from "node:path";
import type { ResolvedRunPlan } from "./config.js";

/**
 * Format the plan into a printable multi-line string. No leading or
 * trailing newline — caller composes spacing.
 */
export function formatResolvedPlan(
  plan: ResolvedRunPlan,
  cwd: string = process.cwd(),
): string {
  const lines: string[] = [];
  const configDisplay = relative(cwd, plan.configPath) || plan.configPath;

  lines.push(`Profile: ${plan.profile}`);
  lines.push(`Config:  ${configDisplay}`);
  lines.push("");

  lines.push("Suites:");
  if (plan.suites.length === 0) {
    lines.push("  (none)");
  } else {
    const nameWidth = Math.max(...plan.suites.map((s) => s.name.length));
    for (const s of plan.suites) {
      const kinds = (s.kinds ?? []).join(", ");
      const kindsDisplay = kinds.length > 0 ? ` [${kinds}]` : "";
      lines.push(`  ${s.name.padEnd(nameWidth)} -> ${s.target}${kindsDisplay}`);
    }
  }
  lines.push("");

  lines.push("Selection:");
  if (plan.selection.tags.length > 0) {
    lines.push(`  tags: ${plan.selection.tags.join(", ")}`);
  }
  if (plan.selection.excludeTags.length > 0) {
    lines.push(`  excludeTags: ${plan.selection.excludeTags.join(", ")}`);
  }
  lines.push(`  tagMode: ${plan.selection.tagMode}`);
  if (plan.selection.filter) {
    lines.push(`  filter: ${plan.selection.filter}`);
  }
  if (plan.selection.pick) {
    lines.push(`  pick: ${plan.selection.pick}`);
  }
  lines.push("");

  lines.push("Execution:");
  lines.push(`  failFast: ${plan.execution.failFast}`);
  lines.push(
    `  failAfter: ${plan.execution.failAfter === null ? "none" : plan.execution.failAfter}`,
  );
  lines.push(`  concurrency: ${plan.execution.concurrency}`);
  lines.push(`  timeoutMs: ${plan.execution.timeoutMs}`);
  if (plan.execution.noSession) {
    lines.push(`  noSession: true`);
  }
  lines.push("");

  lines.push("Reporters:");
  // `reporters.console` (detailed | summary) is parsed from glubean.yaml
  // but NOT yet forwarded into runCommand — runner still uses the legacy
  // verbose flag. Suppressing the line here until the wiring lands keeps
  // the plan output an accurate record of what runs. Re-enable when
  // runCommand honors `printPlan.reporters.console`.
  if (plan.reporters.junit) {
    lines.push(`  junit: ${plan.reporters.junit}`);
  }
  if (plan.reporters.resultJson) {
    lines.push(`  resultJson: ${plan.reporters.resultJson}`);
  }
  if (plan.reporters.emitFullTrace) {
    lines.push(`  emitFullTrace: true`);
  }
  if (plan.reporters.inferSchema) {
    lines.push(`  inferSchema: true`);
  }
  if (plan.reporters.truncateArrays) {
    lines.push(`  truncateArrays: true`);
  }

  const thresholdMetrics = Object.keys(plan.thresholds);
  if (thresholdMetrics.length > 0) {
    lines.push("");
    lines.push("Thresholds:");
    for (const metric of thresholdMetrics) {
      const rules = plan.thresholds[metric];
      const display =
        typeof rules === "string"
          ? rules
          : Object.entries(rules)
              .map(([agg, expr]) => `${agg} ${expr}`)
              .join(", ");
      lines.push(`  ${metric}: ${display}`);
    }
  }

  if (plan.upload?.enabled) {
    lines.push("");
    lines.push("Upload:");
    lines.push(`  enabled: true`);
    if (plan.upload.projectId) {
      lines.push(`  projectId: ${plan.upload.projectId}`);
    }
    // Show the upload destination target so CI logs make a wrong-target upload
    // diagnosable. When unset here it's still resolved at run time (a .env-file
    // GLUBEAN_TARGET_ID / cloud config, else the project's default target).
    lines.push(`  target: ${plan.upload.targetId ?? "(resolved at run: env/.env or default target)"}`);
    if (plan.upload.tokenEnv) {
      lines.push(`  tokenEnv: ${plan.upload.tokenEnv}`);
    }
  }

  return lines.join("\n");
}
