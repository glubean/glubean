/**
 * `glubean contracts` — project contract spec as structured output.
 *
 * Scans the project for .contract.ts files and outputs a human-readable
 * or machine-readable projection of all contract cases, grouped by feature.
 */

import { resolve } from "node:path";
import { bootstrap } from "@glubean/runner";
import { extractContractsFromProject } from "@glubean/scanner";
import type {
  NormalizedFlowMeta,
  NormalizedFlowStep,
  NormalizedFieldMapping,
} from "@glubean/scanner";
import type { ContractStaticMeta, ContractCaseStaticMeta } from "@glubean/scanner/static";
import {
  renderArtifact,
  renderArtifactByName,
  openapiArtifact,
  markdownArtifact,
  assembleMarkdownDocument,
  listArtifactKinds,
  listArtifactCapability,
} from "@glubean/sdk";
import type {
  ExtractedContractProjection,
  MarkdownPart,
} from "@glubean/sdk";

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

/**
 * @deprecated CAR-2 back-compat shim. Delegates to the SDK artifact
 * registry's `assembleMarkdownDocument` (byte-for-byte port of the former
 * inline logic). Kept so existing `formatMdOutline(ContractStaticMeta[])`
 * unit tests keep running while callers migrate to
 * `renderArtifact(markdownArtifact, contracts)` directly.
 *
 * CAR-3 will delete this shim once no consumers call it.
 */
export function formatMdOutline(contracts: ContractStaticMeta[]): string {
  const parts: MarkdownPart[] = contracts.map((c) => ({
    contractId: c.contractId,
    endpoint: c.endpoint,
    protocol: c.protocol,
    description: c.description,
    feature: c.feature,
    instanceName: c.instanceName,
    deprecated: c.deprecated,
    cases: c.cases.map((cs) => {
      const lifecycle =
        (cs.lifecycle as MarkdownPart["cases"][number]["lifecycle"]) ??
        (cs.deprecated
          ? "deprecated"
          : cs.deferred
            ? "deferred"
            : "active");
      return {
        key: cs.key,
        description: cs.description,
        lifecycle,
        severity:
          (cs.severity as MarkdownPart["cases"][number]["severity"]) ??
          "warning",
        defaultRun: cs.defaultRun as MarkdownPart["cases"][number]["defaultRun"],
        requires: cs.requires as MarkdownPart["cases"][number]["requires"],
        deferredReason: cs.deferred,
        deprecatedReason: cs.deprecated,
      };
    }),
  }));
  return assembleMarkdownDocument(parts);
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
  /**
   * Output format:
   *   - `md-outline` (default): feature-grouped markdown spec (legacy path)
   *   - `json`: machine-readable projection
   *   - `openapi`: OpenAPI 3.1 document via artifact registry
   *   - `list-formats`: print registered artifact kinds + protocol capability
   *   - `<kind>`: any kind registered via the artifact registry (dispatched
   *     through `renderArtifactByName`)
   */
  format?: string;
  /** OpenAPI info.title (only used when format=openapi). */
  title?: string;
}

export async function contractsCommand(
  options: ContractsCommandOptions = {},
): Promise<void> {
  const dir = options.dir ? resolve(options.dir) : process.cwd();
  const format = options.format ?? "md-outline";

  // Bootstrap plugins before contract extraction. Without this, any
  // `.contract.ts` file that uses a non-HTTP protocol (graphql, grpc, ...)
  // would fail-closed at `getAdapter(protocol)` because the adapter would
  // not yet be registered — see plugin-manifest-proposal.md D2.
  await bootstrap(dir);

  // `--format list-formats`: introspection of artifact kinds. Resolves
  // after bootstrap so plugin-contributed kinds (future proto/sdl/etc.)
  // are visible. Output to stdout, no contract extraction needed.
  if (format === "list-formats") {
    const kinds = listArtifactKinds();
    const lines: string[] = ["Registered artifact kinds:"];
    for (const name of kinds) {
      const cap = listArtifactCapability(name);
      const parts: string[] = [];
      if (cap.explicit.length > 0) parts.push(`explicit: ${cap.explicit.join(", ")}`);
      if (cap.fallback.length > 0) parts.push(`fallback: ${cap.fallback.join(", ")}`);
      if (cap.unsupported.length > 0) parts.push(`unsupported: ${cap.unsupported.join(", ")}`);
      lines.push(`  ${name}${parts.length > 0 ? ` (${parts.join("; ")})` : ""}`);
    }
    // Plus static formats CLI handles directly
    lines.push("  md-outline (legacy CLI formatter, not via artifact registry)");
    lines.push("  json (legacy CLI formatter, not via artifact registry)");
    process.stdout.write(lines.join("\n") + "\n");
    return;
  }

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
  } else if (format === "openapi") {
    // Dispatched through the artifact registry. Only HTTP contracts
    // contribute (openapi kind has no defaultRender). Non-HTTP protocols
    // are silently skipped — matches pre-CAR-1 behavior of MCP's former
    // `contractsToOpenApi`.
    const spec = renderArtifact(
      openapiArtifact,
      result.contracts as unknown as ExtractedContractProjection<
        unknown,
        unknown
      >[],
      { title: options.title },
    );
    process.stdout.write(JSON.stringify(spec, null, 2) + "\n");
  } else if (format === "md-outline") {
    // CAR-2: `md-outline` contracts section now flows through the artifact
    // registry (`assembleMarkdownDocument` is a byte-for-byte port of the
    // former CLI `formatMdOutline`). Flows section stays on the CLI side
    // per D15 — flow artifact is a future ticket.
    const contractsMd =
      result.contracts.length > 0
        ? renderArtifact(
            markdownArtifact,
            result.contracts as unknown as ExtractedContractProjection<
              unknown,
              unknown
            >[],
          )
        : "";
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
  } else {
    // Dynamic dispatch via artifact registry for any other registered kind
    // name (future proto / sdl / asyncapi). Throws with a helpful error
    // when the name isn't registered — listing available formats in the
    // message.
    try {
      const out = renderArtifactByName(
        format,
        result.contracts as unknown as ExtractedContractProjection<
          unknown,
          unknown
        >[],
      );
      const text = typeof out === "string" ? out : JSON.stringify(out, null, 2);
      process.stdout.write(text.endsWith("\n") ? text : text + "\n");
    } catch (err) {
      console.error(
        `${colors.yellow}⚠ Unknown format "${format}".${colors.reset} ${err instanceof Error ? err.message : String(err)}`,
      );
      console.error(
        `${colors.dim}  Try 'glubean contracts --format list-formats' to see available formats.${colors.reset}`,
      );
      process.exit(1);
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
