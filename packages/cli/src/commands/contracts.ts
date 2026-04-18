/**
 * `glubean contracts` — project contract spec as structured output.
 *
 * Scans the project for .contract.ts files and outputs a human-readable
 * or machine-readable projection of all contract cases, grouped by feature.
 */

import { resolve } from "node:path";
import { extractContractsFromProject } from "@glubean/scanner";
import type {
  NormalizedFlowMeta,
  NormalizedFlowStep,
  NormalizedFieldMapping,
} from "@glubean/scanner";
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
  deprecated: number;
  gated: number;
}

function computeSummary(contracts: ContractStaticMeta[]): ProjectionSummary {
  let total = 0;
  let deferred = 0;
  let deprecated = 0;
  let gated = 0;
  for (const c of contracts) {
    for (const cas of c.cases) {
      total++;
      // Key off lifecycle first (authoritative), fall back to reason strings
      const lifecycle = cas.lifecycle
        ?? (cas.deprecated ? "deprecated" : cas.deferred ? "deferred" : "active");
      if (lifecycle === "deprecated") deprecated++;
      else if (lifecycle === "deferred") deferred++;
      else if (cas.requires === "browser" || cas.requires === "out-of-band") gated++;
    }
  }
  return { total, active: total - deferred - deprecated - gated, deferred, deprecated, gated };
}

// ── Markdown outline formatter ──────────────────────────────────────────────

function formatCase(c: ContractCaseStaticMeta): string {
  const desc = c.description ? ` — ${c.description}` : "";
  // Key off lifecycle first (authoritative), fall back to reason strings
  const lifecycle = c.lifecycle
    ?? (c.deprecated ? "deprecated" : c.deferred ? "deferred" : "active");
  if (lifecycle === "deprecated") {
    const reason = c.deprecated ?? "deprecated";
    return `- ⊘ **${c.key}** — deprecated: ${reason}`;
  }
  if (lifecycle === "deferred") {
    const reason = c.deferred ?? "deferred";
    return `- ⊘ **${c.key}** — deferred: ${reason}`;
  }
  if (c.requires === "browser" || c.requires === "out-of-band") {
    return `- ⊘ **${c.key}** — requires: ${c.requires}`;
  }
  const severityTag = c.severity === "critical" ? " 🔴" : c.severity === "info" ? " ℹ️" : "";
  const suffix = c.defaultRun === "opt-in" ? " *(opt-in)*" : "";
  return `- **${c.key}**${desc}${suffix}${severityTag}`;
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
  if (summary.deprecated > 0) parts.push(`${summary.deprecated} deprecated`);
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
      // Contract-level deprecated marker
      if (contract.deprecated) {
        lines.push(`🚫 **Deprecated:** ${contract.deprecated}`);
        lines.push("");
      }
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

export function formatJson(
  contracts: ContractStaticMeta[],
  flows: NormalizedFlowMeta[] = [],
): string {
  const features = groupByFeature(contracts);
  const summary = computeSummary(contracts);
  const output: Record<string, unknown> = {
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
          lifecycle: cas.lifecycle ?? (cas.deprecated ? "deprecated" : cas.deferred ? "deferred" : "active"),
          severity: cas.severity ?? "warning",
          status: cas.expectStatus,
          deferred: cas.deferred,
          deprecated: cas.deprecated,
          requires: cas.requires,
          defaultRun: cas.defaultRun,
        })),
      })),
    })),
    summary,
  };
  if (flows.length > 0) {
    output.flows = flows.map(flowToJson);
  }
  return JSON.stringify(output, null, 2) + "\n";
}

// ── Flow formatters ─────────────────────────────────────────────────────────

function formatMappingArrow(m: NormalizedFieldMapping): string {
  if (m.source.kind === "path") {
    return `${m.target} ← ${m.source.path}`;
  }
  if (m.source.kind === "literal") {
    return `${m.target} = ${JSON.stringify(m.source.value)}`;
  }
  return `${m.target} ← (pass-through)`;
}

function formatFlowStep(step: NormalizedFlowStep, index: number): string[] {
  const lines: string[] = [];
  if (step.kind === "compute") {
    const name = step.name ? ` — ${step.name}` : "";
    lines.push(`${index + 1}. **<compute>**${name}`);
    const hasAny = (step.reads.length ?? 0) > 0 || (step.writes.length ?? 0) > 0;
    if (hasAny) {
      if (step.reads.length > 0) lines.push(`   - reads: ${step.reads.join(", ")}`);
      if (step.writes.length > 0) lines.push(`   - writes: ${step.writes.join(", ")}`);
    } else {
      lines.push("   - *(mappings not available)*");
    }
    return lines;
  }
  // contract-call
  const name = step.name ? ` — ${step.name}` : "";
  const target = step.target ? ` (${step.protocol} · ${step.target})` : "";
  lines.push(`${index + 1}. **${step.contractId}#${step.caseKey}**${name}${target}`);
  if (step.inputs && step.inputs.length > 0) {
    lines.push("   - inputs:");
    for (const m of step.inputs) lines.push(`     - ${formatMappingArrow(m)}`);
  }
  if (step.outputs && step.outputs.length > 0) {
    lines.push("   - outputs:");
    for (const m of step.outputs) lines.push(`     - ${formatMappingArrow(m)}`);
  }
  return lines;
}

export function formatFlowsMdSection(flows: NormalizedFlowMeta[]): string {
  if (flows.length === 0) return "";
  const lines: string[] = [];
  lines.push("## Flows");
  lines.push("");
  for (const f of flows) {
    const tagSuffix = f.tags && f.tags.length > 0 ? ` *(${f.tags.join(", ")})*` : "";
    lines.push(`### ${f.id}${tagSuffix}`);
    if (f.description) {
      lines.push("");
      lines.push(f.description);
    }
    lines.push("");
    if (f.setupDynamic) {
      lines.push("- setup: *<dynamic>*");
    }
    for (let i = 0; i < f.steps.length; i++) {
      for (const line of formatFlowStep(f.steps[i], i)) {
        lines.push(line);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function flowToJson(f: NormalizedFlowMeta): Record<string, unknown> {
  return {
    id: f.id,
    description: f.description,
    tags: f.tags,
    setupDynamic: f.setupDynamic,
    steps: f.steps.map((s) => {
      if (s.kind === "compute") {
        return {
          kind: "compute",
          name: s.name,
          reads: s.reads,
          writes: s.writes,
        };
      }
      return {
        kind: "contract-call",
        name: s.name,
        contractId: s.contractId,
        caseKey: s.caseKey,
        protocol: s.protocol,
        target: s.target,
        inputs: s.inputs,
        outputs: s.outputs,
      };
    }),
  };
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

  const result = await extractContractsFromProject(dir);
  const flows = result.flows ?? [];

  // Surface import errors
  if (result.errors.length > 0) {
    for (const err of result.errors) {
      console.error(`${colors.yellow}⚠ Import failed: ${err.file}${colors.reset}`);
      console.error(`${colors.dim}  ${err.error}${colors.reset}`);
    }
  }

  if (result.contracts.length === 0 && flows.length === 0) {
    console.error(
      `${colors.yellow}No contracts or flows found.${colors.reset} ` +
      `Ensure .contract.ts / .flow.ts files exist and use contract.http.with() or contract.flow().`,
    );
    process.exit(1);
  }

  // Map NormalizedContractMeta → ContractStaticMeta for formatters
  // Instance-aware: use "instanceName: feature" as the feature key when instances exist
  const hasInstances = result.contracts.some((ec) => ec.instanceName);
  const contracts: ContractStaticMeta[] = result.contracts.map((ec) => ({
    contractId: ec.id,
    exportName: ec.exportName,
    endpoint: ec.target,
    protocol: ec.protocol,
    description: ec.description,
    feature: hasInstances && ec.instanceName
      ? `${ec.instanceName}: ${ec.feature ?? ec.target}`
      : ec.feature,
    deprecated: ec.deprecated,
    line: 0,
    cases: ec.cases.map((c) => {
      // Scanner emits `schemas` as an opaque blob after v0.2. For HTTP
      // contracts the shape is { response: { status, headers, examples, ... } }.
      const schemas = c.schemas as
        | {
            response?: {
              status?: number;
              headers?: unknown;
              examples?: unknown;
            };
          }
        | undefined;
      return {
        key: c.key,
        description: c.description,
        expectStatus: schemas?.response?.status,
        deferred: c.deferredReason,
        deprecated: c.deprecatedReason,
        lifecycle: c.lifecycle,
        severity: c.severity,
        requires: c.requires as any,
        defaultRun: c.defaultRun as any,
        hasHeaderSchema: schemas?.response?.headers != null,
        hasExample: schemas?.response?.examples != null,
        line: 0,
      };
    }),
  }));

  // Output projection
  if (format === "json") {
    process.stdout.write(formatJson(contracts, flows));
  } else {
    const contractsMd = contracts.length > 0 ? formatMdOutline(contracts) : "";
    const flowsMd = flows.length > 0 ? formatFlowsMdSection(flows) : "";
    if (contractsMd && flowsMd) {
      process.stdout.write(contractsMd.trimEnd() + "\n\n" + flowsMd);
    } else {
      // Even if contracts are empty, render a minimal header + flows block
      if (!contractsMd) {
        const date = new Date().toISOString().slice(0, 10);
        process.stdout.write(
          `# Contract Specification\n\nGenerated: ${date} | ${flows.length} flow(s)\n\n`,
        );
      }
      process.stdout.write(contractsMd || flowsMd);
    }
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
