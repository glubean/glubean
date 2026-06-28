import { resolve, basename } from "node:path";
import { writeFile } from "node:fs/promises";
import { scan, extractContractsFromProject } from "@glubean/scanner";
import { dryRunFiles, bootstrap } from "@glubean/runner";
import {
  renderArtifact,
  openapiArtifact,
  type ExtractedContractProjection,
} from "@glubean/sdk";

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  red: "\x1b[31m",
};

export interface DryRunCommandOptions {
  dir?: string;
  json?: boolean;
  out?: string;
}

/** One projected test, merged from static scan metadata + dynamic dry-run shape. */
export interface ProjectedTest {
  testId: string;
  exportName: string;
  file: string;
  description?: string;
  deprecated?: string;
  requires?: string;
  defaultRun?: string;
  tags?: string[];
  assertions: Array<{ kind: string; message?: string; branch?: string }>;
  endpoints: Array<{ method: string; url: string; branch?: string }>;
  assertionCount: number;
  projectionComplete: boolean;
  incompleteReason?: string;
  skipped?: boolean;
}

/** One projected contract (C1) — the scanner's static normalized contract, plus
 *  derived head fields, for upload to /projections/contract. */
export interface ProjectedContract {
  contractId: string;
  protocol: string;
  target?: string;
  description?: string;
  deprecated?: string;
  tags?: string[];
  caseCount: number;
  /** Full normalized contract (cases + schemas). */
  projection: unknown;
  projectionComplete: boolean;
  incompleteReason?: string;
}

/** One projected workflow (C1) — the scanner's static normalized workflow. */
export interface ProjectedWorkflow {
  workflowId: string;
  name?: string;
  description?: string;
  tags?: string[];
  nodeCount: number;
  /** Full normalized workflow (node tree + phases). */
  projection: unknown;
  projectionComplete: boolean;
  incompleteReason?: string;
}

export interface ProjectionResult {
  projected: ProjectedTest[];
  files: string[];
  errors: Array<{ file: string; message: string }>;
  /** Scanner warnings (e.g. "Failed to extract metadata from <file>: …") — a
   *  file whose metadata couldn't be extracted is omitted from `files`/`projected`
   *  entirely, so a full-snapshot sync must treat these as fatal. */
  warnings: string[];
  /** Test-named files that yielded ZERO exports (parser recovered from a syntax
   *  error, or a misnamed module) — silently dropped, so also fatal for sync. */
  emptyTestFiles: string[];
  /** Statically-projected contracts (declarative — no dry-run). */
  contracts: ProjectedContract[];
  /** Statically-projected workflows (declarative — no dry-run). */
  workflows: ProjectedWorkflow[];
  /** OpenAPI 3.1 doc rendered from the project's HTTP contracts, for the Cloud
   *  api-reference view (endpoints/schemas with constraints/formats/enums). `null`
   *  when the project has no HTTP endpoints (a full sync then clears any stale doc).
   *  See `openapiFailed` for the render-error case. */
  openapi?: Record<string, unknown> | null;
  /** True when OpenAPI rendering THREW (bootstrap/extract/render). Distinct from a
   *  `null` doc: sync SKIPS the openapi upload on failure, so a transient error never
   *  wipes the project's previously-synced API reference. */
  openapiFailed?: boolean;
}

/**
 * Scan + dry-run a directory and merge static scan metadata
 * (description/deprecated/requires/defaultRun/bareBranchCount) with each test's
 * dynamic dry-run shape. Shared by `glubean dry-run` (print) and `glubean sync`
 * (upload).
 */
export async function buildProjections(dir: string): Promise<ProjectionResult> {
  // Bootstrap the project's SDK runtime/plugins BEFORE any contract/flow module is
  // imported — both `scan` (below) and `extractContractsFromProject` (for the OpenAPI
  // render) import them. A project that relies on `glubean.setup.*` to make its
  // contracts importable would otherwise cache a FAILED ESM evaluation from scan's
  // first import, breaking every later extraction (the OpenAPI render would silently
  // go null). Best-effort: a bootstrap failure must NOT break scan / dry-run for
  // projects that don't need setup.
  try {
    await bootstrap(dir);
  } catch {
    // ignore — scan/dry-run may still work; the OpenAPI extract fail-softs below
  }

  const scanResult = await scan(dir);

  // Build a lookup of static metadata keyed by absolute file + export name.
  const metaByKey = new Map<
    string,
    {
      description?: string;
      deprecated?: string;
      requires?: string;
      defaultRun?: string;
      tags?: string[];
      bareBranchCount?: number;
    }
  >();
  const fileSet = new Set<string>();
  for (const [relPath, fileMeta] of Object.entries(scanResult.files)) {
    const absPath = resolve(dir, relPath);
    for (const exp of fileMeta.exports) {
      // Only simple tests have a dry-runnable body; workflows are statically shaped.
      if (exp.workflow) continue;
      fileSet.add(absPath);
      metaByKey.set(`${absPath}::${exp.exportName}`, {
        description: exp.description,
        deprecated: exp.deprecated,
        requires: exp.requires,
        defaultRun: exp.defaultRun,
        tags: exp.tags,
        bareBranchCount: exp.bareBranchCount,
      });
    }
  }

  const files = [...fileSet];
  const { shapes, errors } = await dryRunFiles(files, { cwd: dir });

  const projected: ProjectedTest[] = shapes.map((s) => {
    const meta = metaByKey.get(`${s.file}::${s.exportName}`) ?? {};
    let projectionComplete = s.projectionComplete;
    let incompleteReason = s.incompleteReason;
    // Fold the static bare-branch signal: a native if/switch means only one arm
    // was followed, so the shape is partial even if execution succeeded.
    if (projectionComplete && meta.bareBranchCount && meta.bareBranchCount > 0) {
      projectionComplete = false;
      incompleteReason = `${meta.bareBranchCount} bare branch/loop(s) — use ctx.when()/ctx.switch()/ctx.while() for full projection`;
    }
    return {
      testId: s.testId,
      exportName: s.exportName,
      file: s.file,
      description: meta.description,
      deprecated: meta.deprecated,
      requires: meta.requires,
      defaultRun: meta.defaultRun,
      // Prefer the RUNTIME shape's tags (test.meta.tags) so data-driven `tagFields`
      // row tags survive; fall back to the static scan tags when the project's
      // runner predates shape tags (version skew), so statically-tagged tests
      // aren't published with empty tags.
      ...((s.tags ?? meta.tags)?.length ? { tags: s.tags ?? meta.tags } : {}),
      assertions: s.assertions,
      endpoints: s.endpoints,
      assertionCount: s.assertionCount,
      projectionComplete,
      ...(incompleteReason ? { incompleteReason } : {}),
      ...(s.skipped ? { skipped: true } : {}),
    };
  });

  projected.sort((a, b) => a.testId.localeCompare(b.testId));

  // Contracts + workflows are DECLARATIVE — the scanner already produced their full
  // normalized projection statically (no dry-run). Map to the upload shape; the
  // normalized blob is the reviewable body, the head fields derive from it.
  const contracts: ProjectedContract[] = (scanResult.contractsProjection ?? []).map((c) => ({
    contractId: c.id,
    protocol: c.protocol,
    target: c.target,
    description: c.description,
    deprecated: c.deprecated,
    tags: c.tags,
    caseCount: c.cases?.length ?? 0,
    projection: c,
    projectionComplete: !(c.unprojectableSchemas && c.unprojectableSchemas.length > 0),
    ...(c.unprojectableSchemas && c.unprojectableSchemas.length > 0
      ? { incompleteReason: `${c.unprojectableSchemas.length} declared schema(s) couldn't be projected` }
      : {}),
  }));
  const workflows: ProjectedWorkflow[] = (scanResult.workflows ?? []).map((w) => {
    const g = w.gradeSummary ?? { full: 0, partial: 0, opaque: 0 };
    const nodeCount = (g.full ?? 0) + (g.partial ?? 0) + (g.opaque ?? 0);
    return {
      workflowId: w.id,
      name: w.name,
      description: w.description,
      tags: w.tags,
      nodeCount,
      projection: w,
      projectionComplete: (g.opaque ?? 0) === 0,
      ...((g.opaque ?? 0) > 0
        ? { incompleteReason: `${g.opaque} node(s) projected opaque — not fully statically shaped` }
        : {}),
    };
  });
  contracts.sort((a, b) => a.contractId.localeCompare(b.contractId));
  workflows.sort((a, b) => a.workflowId.localeCompare(b.workflowId));

  // Render an OpenAPI 3.1 doc from the SAME contracts, so Cloud can show
  // endpoints/schemas with the published api-reference view. This needs the
  // RUNTIME extraction (real schema objects → JSON Schema); the static scan's
  // `contractsProjection` can't produce it. Same-process ESM import is cached,
  // so this doesn't re-run contract module side effects. Best-effort — a failure
  // here never blocks the test/contract/workflow projection.
  // Three DISTINCT states, because sync treats them differently:
  //   • a real doc (has HTTP paths)   → upload it
  //   • no HTTP endpoints (null)      → upload null, clearing any stale doc
  //   • render FAILED (openapiFailed) → sync SKIPS the upload, preserving the prior doc
  // (so a transient bootstrap/extract/render error never wipes the API reference).
  let openapi: Record<string, unknown> | null = null;
  let openapiFailed = false;
  try {
    // bootstrap already ran at the top of buildProjections (before scan imported the
    // contract modules), so the runtime extraction below resolves cleanly.
    const { contracts: rawContracts, errors: extractErrors } = await extractContractsFromProject(dir);
    if (extractErrors && extractErrors.length > 0) {
      // Per-file import/synthesis failures are REPORTED here (not thrown). A partial
      // extraction must not publish a half-doc or clear the prior one — skip + preserve.
      openapiFailed = true;
    } else if (rawContracts.length > 0) {
      const doc = renderArtifact(
        openapiArtifact,
        rawContracts as unknown as ExtractedContractProjection<unknown, unknown>[],
        { title: basename(dir) || "API Specification" },
      ) as Record<string, unknown>;
      // An empty fallback (non-HTTP / inbound-only contracts) carries no paths — that's
      // "no API reference" (null → clear), NOT a real doc.
      const paths = doc?.paths as Record<string, unknown> | undefined;
      openapi = paths && Object.keys(paths).length > 0 ? doc : null;
    }
  } catch {
    // Render threw — keep `openapi` null but flag the failure so sync skips the upload
    // instead of clearing a previously-synced doc.
    openapiFailed = true;
  }

  return {
    projected,
    files,
    errors,
    warnings: scanResult.warnings,
    emptyTestFiles: scanResult.emptyTestFiles,
    contracts,
    workflows,
    openapi,
    openapiFailed,
  };
}

/**
 * `glubean dry-run` — project the SHAPE of every simple test (assertions made,
 * endpoints hit) without running them, for cloud team review. Combines static
 * scan metadata (description/deprecated/bareBranchCount) with the dynamic
 * dry-run projection.
 */
export async function dryRunCommand(options: DryRunCommandOptions = {}): Promise<void> {
  const dir = options.dir ? resolve(options.dir) : process.cwd();
  const { projected, files, errors, warnings, emptyTestFiles, openapi } = await buildProjections(dir);
  // Files that contribute NO projection though they look like tests — a sync
  // would silently drop them (see syncCommand).
  const dropped = [
    ...warnings.filter((w) => w.startsWith("Failed to extract metadata from")),
    ...emptyTestFiles.map(
      (f) => `${f} — a Glubean test file with no extractable tests (syntax error, or tests removed/unrecognized?)`,
    ),
  ];

  if (options.out) {
    await writeFile(resolve(options.out), JSON.stringify({ tests: projected, errors, warnings, emptyTestFiles, openapi }, null, 2));
  }

  if (options.json) {
    console.log(JSON.stringify({ tests: projected, errors, warnings, emptyTestFiles, openapi }, null, 2));
    return;
  }

  // ── Human-readable ──
  console.log(`\n${colors.bold}${colors.blue}🔬 Glubean Dry-Run (shape projection)${colors.reset}\n`);
  console.log(`${colors.dim}Directory: ${dir}${colors.reset}`);
  console.log(`${colors.dim}Projected: ${projected.length} test(s) from ${files.length} file(s)${colors.reset}\n`);

  for (const t of projected) {
    const flag = t.skipped
      ? `${colors.yellow}(skipped)${colors.reset}`
      : t.projectionComplete
        ? `${colors.green}● complete${colors.reset}`
        : `${colors.yellow}◐ partial${colors.reset}`;
    console.log(`${colors.bold}${t.testId}${colors.reset}  ${flag}`);
    if (t.description) console.log(`  ${colors.dim}${t.description}${colors.reset}`);
    if (t.deprecated) console.log(`  ${colors.yellow}⚠ deprecated: ${t.deprecated}${colors.reset}`);
    if (t.endpoints.length) {
      const eps = t.endpoints.map((e) => `${e.method} ${e.url}`).join(", ");
      console.log(`  ${colors.dim}endpoints:${colors.reset} ${eps}`);
    }
    console.log(`  ${colors.dim}assertions (${t.assertionCount}):${colors.reset}`);
    for (const a of t.assertions) {
      const label = a.message ? `${a.kind} "${a.message}"` : a.kind;
      const branch = a.branch ? ` ${colors.dim}[${a.branch}]${colors.reset}` : "";
      console.log(`    - ${label}${branch}`);
    }
    if (!t.projectionComplete && t.incompleteReason) {
      console.log(`  ${colors.yellow}⚠ partial: ${t.incompleteReason}${colors.reset}`);
    }
    console.log();
  }

  if (errors.length) {
    console.log(`${colors.red}Import errors:${colors.reset}`);
    for (const e of errors) console.log(`  ${colors.red}✗ ${e.file}: ${e.message}${colors.reset}`);
    console.log();
  }

  if (dropped.length) {
    console.log(`${colors.red}Dropped files (their tests are omitted — sync would delete them):${colors.reset}`);
    for (const w of dropped) console.log(`  ${colors.red}✗ ${w}${colors.reset}`);
    console.log();
  }
}
