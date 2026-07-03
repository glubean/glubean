/**
 * `glubean contracts` — project contract spec as structured output.
 *
 * Scans the project for .contract.ts files and outputs a human-readable
 * or machine-readable projection of all contract cases, grouped by feature.
 */

import { resolve, dirname, relative } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { bootstrap } from "@glubean/runner";
import { extractContractsFromProject } from "@glubean/scanner";
import type {
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
import {
  GlubeanConfigError,
  loadProjectConfigV1,
  listContractProjectionNames,
  resolveContractProjection,
} from "../lib/config.js";
import type { ResolvedContractProjection } from "../lib/config.js";

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

function formatStaticVerifyRule(
  rule: NonNullable<ContractCaseStaticMeta["verifyRules"]>[number],
): string {
  if (typeof rule === "string") return rule;
  const prefix = rule.id ? `${rule.id}: ` : "";
  return `${prefix}${rule.description}`;
}

function formatCase(c: ContractCaseStaticMeta): string {
  const desc = c.description ? ` — ${c.description}` : "";
  const projectionNotes = [
    c.given ? `given: ${c.given}` : undefined,
    c.verifyRules && c.verifyRules.length > 0
      ? `verifies: ${c.verifyRules.map(formatStaticVerifyRule).join("; ")}`
      : c.hasVerify
        ? "has verify()"
        : undefined,
  ].filter(Boolean);
  const notes = projectionNotes.length > 0 ? ` *(${projectionNotes.join("; ")})*` : "";
  // Key off lifecycle first (authoritative), fall back to reason strings
  const lifecycle = c.lifecycle
    ?? (c.deprecated ? "deprecated" : c.deferred ? "deferred" : "active");
  if (lifecycle === "deprecated") {
    const reason = c.deprecated ?? "deprecated";
    return `- ⊘ **${c.key}** — deprecated: ${reason}${notes}`;
  }
  if (lifecycle === "deferred") {
    const reason = c.deferred ?? "deferred";
    return `- ⊘ **${c.key}** — deferred: ${reason}${notes}`;
  }
  if (c.requires === "browser" || c.requires === "out-of-band") {
    return `- ⊘ **${c.key}** — requires: ${c.requires}${notes}`;
  }
  const severityTag = c.severity === "critical" ? " 🔴" : c.severity === "info" ? " ℹ️" : "";
  const suffix = c.defaultRun === "opt-in" ? " *(opt-in)*" : "";
  return `- **${c.key}**${desc}${notes}${suffix}${severityTag}`;
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
    // ContractStaticMeta doesn't carry instanceName — the CLI command
    // already folded instanceName into `feature` upstream (hasInstances
    // pre-pass). Leaving instanceName undefined here keeps
    // assembleMarkdownDocument's own hasInstances branch off, so the
    // already-prefixed feature string is used verbatim.
    feature: c.feature,
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
        given: cs.given,
        hasVerify: cs.hasVerify,
        verifyRules: cs.verifyRules as MarkdownPart["cases"][number]["verifyRules"],
      };
    }),
  }));
  return assembleMarkdownDocument(parts);
}

// ── JSON formatter ──────────────────────────────────────────────────────────

export function formatJson(contracts: ContractStaticMeta[]): string {
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
          given: cas.given,
          hasVerify: cas.hasVerify,
          verifyRules: cas.verifyRules,
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
  /**
   * Name of a `projections.contracts.<name>` entry declared in
   * `glubean.yaml` — or `"all"` to generate every declared entry. When set,
   * `--dir` / `--format` / `--title` are ignored (each projection carries
   * its own); output is written to each entry's `output` path instead of
   * stdout.
   */
  projection?: string;
  /** Path to `glubean.yaml` (default: `./glubean.yaml`). Used with `--projection`. */
  config?: string;
}

/** Thrown by `renderContracts` when a scanned directory has zero contracts. */
class NoContractsFoundError extends Error {
  constructor(
    dir: string,
    public readonly importErrors: Array<{ file: string; error: string }>,
  ) {
    super(`No contracts found in ${dir}. Ensure .contract.ts files exist and use contract.http.with().`);
    this.name = "NoContractsFoundError";
  }
}

interface RenderedContracts {
  text: string;
  warnings: DescriptionWarning[];
  importErrors: Array<{ file: string; error: string }>;
}

/**
 * Bootstrap plugins, extract contracts from `dir`, and render them through
 * `format`. Shared by the direct `--dir/--format` CLI path and the
 * `--projection` (glubean.yaml-declared) path — both need the identical
 * extract → map → dispatch pipeline, just different output sinks.
 *
 * Throws `NoContractsFoundError` when the scan yields zero contracts, and
 * propagates `renderArtifactByName`'s "unknown format" error verbatim for
 * unrecognized dynamic kinds. Callers decide how to present/exit on those.
 */
async function renderContracts(
  dir: string,
  format: string,
  title: string | undefined,
): Promise<RenderedContracts> {
  // Bootstrap plugins before contract extraction. Without this, any
  // `.contract.ts` file that uses a non-HTTP protocol (graphql, grpc, ...)
  // would fail-closed at `getAdapter(protocol)` because the adapter would
  // not yet be registered — see plugin-manifest-proposal.md D2.
  await bootstrap(dir);

  const result = await extractContractsFromProject(dir);

  if (result.contracts.length === 0) {
    throw new NoContractsFoundError(dir, result.errors);
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
        given: c.given,
        hasVerify: c.hasVerify,
        verifyRules: c.verifyRules as any,
        hasHeaderSchema: schemas?.response?.headers != null,
        hasExample: schemas?.response?.examples != null,
        line: 0,
      };
    }),
  }));

  // Render projection
  let text: string;
  if (format === "json") {
    text = formatJson(contracts);
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
      { title },
    );
    text = JSON.stringify(spec, null, 2) + "\n";
  } else if (format === "md-outline") {
    // CAR-2: `md-outline` renders through the artifact registry
    // (`assembleMarkdownDocument`). The legacy flows section died with
    // contract.flow (Nv1-D3); workflow markdown is the agreement-markdown
    // proposal (G1).
    text = renderArtifact(
      markdownArtifact,
      result.contracts as unknown as ExtractedContractProjection<
        unknown,
        unknown
      >[],
    );
  } else {
    // Dynamic dispatch via artifact registry for any other registered kind
    // name (future proto / sdl / asyncapi). Throws with a helpful error
    // when the name isn't registered — listing available formats in the
    // message.
    const out = renderArtifactByName(
      format,
      result.contracts as unknown as ExtractedContractProjection<
        unknown,
        unknown
      >[],
    );
    text = typeof out === "string" ? out : JSON.stringify(out, null, 2);
    if (!text.endsWith("\n")) text += "\n";
  }

  // Lint warnings
  const warnings: DescriptionWarning[] = [];
  for (const c of contracts) {
    if (c.description) {
      const w = lintDescription(c.contractId, "(contract)", c.description);
      if (w) warnings.push(w);
    }
    for (const cas of c.cases) {
      if (cas.description) {
        const w = lintDescription(c.contractId, cas.key, cas.description);
        if (w) warnings.push(w);
      }
    }
  }

  return { text, warnings, importErrors: result.errors };
}

function printImportErrors(importErrors: RenderedContracts["importErrors"]): void {
  for (const err of importErrors) {
    console.error(`${colors.yellow}⚠ Import failed: ${err.file}${colors.reset}`);
    console.error(`${colors.dim}  ${err.error}${colors.reset}`);
  }
}

function printWarnings(warnings: DescriptionWarning[], label?: string): void {
  if (warnings.length === 0) return;
  console.error("");
  console.error(
    `${colors.yellow}⚠ Description warnings${label ? ` (${label})` : ""}:${colors.reset}`,
  );
  for (const w of warnings) {
    console.error(`${colors.dim}  ${w.contractId}.${w.caseKey}: ${w.message}${colors.reset}`);
  }
}

/** Generate one resolved `projections.contracts.<name>` entry, writing to its `output` path. */
async function runNamedProjection(
  rootDir: string,
  resolved: ResolvedContractProjection,
): Promise<boolean> {
  let rendered: RenderedContracts;
  try {
    rendered = await renderContracts(resolved.dir, resolved.format, resolved.title);
  } catch (err) {
    if (err instanceof NoContractsFoundError) printImportErrors(err.importErrors);
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${colors.yellow}✗ ${resolved.name}: ${message}${colors.reset}`);
    return false;
  }

  printImportErrors(rendered.importErrors);

  await mkdir(dirname(resolved.output), { recursive: true });
  await writeFile(resolved.output, rendered.text, "utf-8");
  console.log(
    `${colors.blue}✓${colors.reset} ${resolved.name} → ${relative(rootDir, resolved.output)}`,
  );

  printWarnings(rendered.warnings, resolved.name);
  return true;
}

/** `--projection <name|all>`: resolve declared projection(s) from glubean.yaml and generate them. */
async function runProjections(
  cwd: string,
  options: ContractsCommandOptions,
): Promise<void> {
  let loaded: Awaited<ReturnType<typeof loadProjectConfigV1>>;
  try {
    loaded = await loadProjectConfigV1(cwd, options.config ? { configPath: options.config } : {});
  } catch (err) {
    if (!(err instanceof GlubeanConfigError)) throw err;
    console.error(`${colors.yellow}${err.message}${colors.reset}`);
    process.exit(1);
  }
  const { config, configPath } = loaded;

  const names =
    options.projection === "all" ? listContractProjectionNames(config) : [options.projection as string];

  if (names.length === 0) {
    console.error(
      `${colors.yellow}No contract projections declared in glubean.yaml (projections.contracts).${colors.reset}`,
    );
    process.exit(1);
  }

  let anyFailed = false;
  for (const name of names) {
    let resolved: ResolvedContractProjection;
    try {
      resolved = resolveContractProjection(config, configPath, cwd, name);
    } catch (err) {
      if (!(err instanceof GlubeanConfigError)) throw err;
      console.error(`${colors.yellow}${err.message}${colors.reset}`);
      anyFailed = true;
      continue;
    }
    const ok = await runNamedProjection(cwd, resolved);
    if (!ok) anyFailed = true;
  }

  if (anyFailed) process.exit(1);
}

export async function contractsCommand(
  options: ContractsCommandOptions = {},
): Promise<void> {
  const cwd = process.cwd();

  if (options.projection) {
    await runProjections(cwd, options);
    return;
  }

  const dir = options.dir ? resolve(options.dir) : cwd;
  const format = options.format ?? "md-outline";

  // Bootstrap plugins before contract extraction (also needed for
  // `list-formats`, which resolves plugin-contributed artifact kinds).
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

  let rendered: RenderedContracts;
  try {
    rendered = await renderContracts(dir, format, options.title);
  } catch (err) {
    if (err instanceof NoContractsFoundError) {
      printImportErrors(err.importErrors);
      console.error(
        `${colors.yellow}No contracts found.${colors.reset} ` +
        `Ensure .contract.ts files exist and use contract.http.with().`,
      );
      process.exit(1);
    }
    console.error(
      `${colors.yellow}⚠ Unknown format "${format}".${colors.reset} ${err instanceof Error ? err.message : String(err)}`,
    );
    console.error(
      `${colors.dim}  Try 'glubean contracts --format list-formats' to see available formats.${colors.reset}`,
    );
    process.exit(1);
  }

  printImportErrors(rendered.importErrors);
  process.stdout.write(rendered.text);
  printWarnings(rendered.warnings);
}
