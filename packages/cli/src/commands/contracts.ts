/**
 * `glubean contracts` — project contract spec as structured output.
 *
 * Scans the project for .contract.ts files and outputs a human-readable
 * or machine-readable projection of all contract cases, grouped by feature.
 */

import { resolve } from "node:path";
import { createScanner } from "@glubean/scanner";
import type { ContractStaticMeta, ContractCaseStaticMeta } from "@glubean/scanner/static";

// ── Description lint ────────────────────────────────────────────────────────

export interface DescriptionWarning {
  contractId: string;
  caseKey: string;
  message: string;
}

const LINT_RULES: Array<{ pattern: RegExp; message: string }> = [
  {
    pattern: /^(GET|POST|PUT|PATCH|DELETE)\b/,
    message: "description starts with HTTP method — use business language instead",
  },
  {
    pattern: /returns?\s+\d{3}/i,
    message: "description contains status code — describe the user experience instead",
  },
  {
    pattern: /\bstatus\s*code\b/i,
    message: "description contains 'status code' — use business language instead",
  },
  {
    pattern: /\b(endpoint|request body|response body|payload)\b/i,
    message: "description contains technical jargon — describe what the user experiences",
  },
];

export function lintDescription(
  contractId: string,
  caseKey: string,
  description: string,
): DescriptionWarning | undefined {
  for (const rule of LINT_RULES) {
    if (rule.pattern.test(description)) {
      return { contractId, caseKey, message: rule.message };
    }
  }
  return undefined;
}

// ── Feature grouping ────────────────────────────────────────────────────────

interface FeatureGroup {
  name: string;
  contracts: ContractStaticMeta[];
}

function groupByFeature(contracts: ContractStaticMeta[]): FeatureGroup[] {
  const groups = new Map<string, ContractStaticMeta[]>();
  for (const c of contracts) {
    const key = c.feature ?? c.endpoint;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }
  return Array.from(groups.entries()).map(([name, contracts]) => ({
    name,
    contracts,
  }));
}

// ── Summary stats ───────────────────────────────────────────────────────────

interface ProjectionSummary {
  total: number;
  active: number;
  deferred: number;
  gated: number;
}

function computeSummary(contracts: ContractStaticMeta[]): ProjectionSummary {
  let total = 0;
  let deferred = 0;
  let gated = 0;
  for (const c of contracts) {
    for (const cas of c.cases) {
      total++;
      if (cas.deferred) deferred++;
      else if (cas.requires === "browser" || cas.requires === "out-of-band") gated++;
    }
  }
  return { total, active: total - deferred - gated, deferred, gated };
}

// ── Markdown outline formatter ──────────────────────────────────────────────

function formatCase(c: ContractCaseStaticMeta): string {
  const desc = c.description ? ` — ${c.description}` : "";
  if (c.deferred) {
    return `- ⊘ **${c.key}** — deferred: ${c.deferred}`;
  }
  if (c.requires === "browser" || c.requires === "out-of-band") {
    return `- ⊘ **${c.key}** — requires: ${c.requires}`;
  }
  const suffix = c.defaultRun === "opt-in" ? " *(opt-in)*" : "";
  return `- **${c.key}**${desc}${suffix}`;
}

export function formatMdOutline(contracts: ContractStaticMeta[]): string {
  const features = groupByFeature(contracts);
  const summary = computeSummary(contracts);
  const lines: string[] = [];

  lines.push("# Contract Specification");
  lines.push("");
  const date = new Date().toISOString().slice(0, 10);
  const parts = [`Generated: ${date}`, `${summary.total} cases`];
  if (summary.active > 0) parts.push(`${summary.active} active`);
  if (summary.deferred > 0) parts.push(`${summary.deferred} deferred`);
  if (summary.gated > 0) parts.push(`${summary.gated} gated`);
  lines.push(parts.join(" | "));
  lines.push("");

  for (const feature of features) {
    lines.push(`## ${feature.name}`);
    lines.push("");

    for (const contract of feature.contracts) {
      // Contract description as intro line under the feature heading.
      // Priority: explicit description > endpoint (if feature differs from endpoint)
      const intro = contract.description
        ?? (feature.name !== contract.endpoint ? contract.endpoint : undefined);
      if (intro) {
        lines.push(intro);
        lines.push("");
      }

      for (const c of contract.cases) {
        lines.push(formatCase(c));
      }
      lines.push("");
    }
  }

  return lines.join("\n").trimEnd() + "\n";
}

// ── JSON formatter ──────────────────────────────────────────────────────────

export function formatJson(contracts: ContractStaticMeta[]): string {
  const features = groupByFeature(contracts);
  const summary = computeSummary(contracts);
  const output = {
    generated: new Date().toISOString(),
    features: features.map((f) => ({
      name: f.name,
      contracts: f.contracts.map((c) => ({
        id: c.contractId,
        endpoint: c.endpoint,
        description: c.description,
        feature: c.feature,
        cases: c.cases.map((cas) => ({
          key: cas.key,
          description: cas.description,
          status: cas.expectStatus,
          deferred: cas.deferred,
          requires: cas.requires,
          defaultRun: cas.defaultRun,
        })),
      })),
    })),
    summary,
  };
  return JSON.stringify(output, null, 2) + "\n";
}

// ── Command ─────────────────────────────────────────────────────────────────

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
};

export interface ContractsCommandOptions {
  dir?: string;
  format?: "md-outline" | "json";
}

export async function contractsCommand(
  options: ContractsCommandOptions = {},
): Promise<void> {
  const dir = options.dir ? resolve(options.dir) : process.cwd();
  const format = options.format ?? "md-outline";

  const scanner = createScanner();
  const result = await scanner.scan(dir);
  const contracts = result.contracts ?? [];

  if (contracts.length === 0) {
    console.error(
      `${colors.yellow}No contracts found.${colors.reset} ` +
      `Ensure .contract.ts files exist and use contract.http.with().`,
    );
    process.exit(1);
  }

  // Output projection
  if (format === "json") {
    process.stdout.write(formatJson(contracts));
  } else {
    process.stdout.write(formatMdOutline(contracts));
  }

  // Lint warnings (stderr, so they don't pollute piped output)
  const warnings: DescriptionWarning[] = [];
  for (const c of contracts) {
    // Lint contract-level description
    if (c.description) {
      const w = lintDescription(c.contractId, "(contract)", c.description);
      if (w) warnings.push(w);
    }
    // Lint case-level descriptions
    for (const cas of c.cases) {
      if (cas.description) {
        const w = lintDescription(c.contractId, cas.key, cas.description);
        if (w) warnings.push(w);
      }
    }
  }
  if (warnings.length > 0) {
    console.error("");
    console.error(`${colors.yellow}⚠ Description warnings:${colors.reset}`);
    for (const w of warnings) {
      console.error(
        `${colors.dim}  ${w.contractId}.${w.caseKey}: ${w.message}${colors.reset}`,
      );
    }
  }
}
