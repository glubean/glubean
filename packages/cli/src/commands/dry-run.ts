import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { scan } from "@glubean/scanner";
import { dryRunFiles } from "@glubean/runner";

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
interface ProjectedTest {
  testId: string;
  exportName: string;
  file: string;
  description?: string;
  deprecated?: string;
  requires?: string;
  defaultRun?: string;
  assertions: Array<{ kind: string; message?: string; branch?: string }>;
  endpoints: Array<{ method: string; url: string; branch?: string }>;
  assertionCount: number;
  projectionComplete: boolean;
  incompleteReason?: string;
  skipped?: boolean;
}

/**
 * `glubean dry-run` — project the SHAPE of every simple test (assertions made,
 * endpoints hit) without running them, for cloud team review. Combines static
 * scan metadata (description/deprecated/bareBranchCount) with the dynamic
 * dry-run projection.
 */
export async function dryRunCommand(options: DryRunCommandOptions = {}): Promise<void> {
  const dir = options.dir ? resolve(options.dir) : process.cwd();

  const scanResult = await scan(dir);

  // Build a lookup of static metadata keyed by absolute file + export name.
  const metaByKey = new Map<
    string,
    {
      description?: string;
      deprecated?: string;
      requires?: string;
      defaultRun?: string;
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
      incompleteReason = `${meta.bareBranchCount} bare if/switch branch(es) — use ctx.when()/ctx.switch() for full projection`;
    }
    return {
      testId: s.testId,
      exportName: s.exportName,
      file: s.file,
      description: meta.description,
      deprecated: meta.deprecated,
      requires: meta.requires,
      defaultRun: meta.defaultRun,
      assertions: s.assertions,
      endpoints: s.endpoints,
      assertionCount: s.assertionCount,
      projectionComplete,
      ...(incompleteReason ? { incompleteReason } : {}),
      ...(s.skipped ? { skipped: true } : {}),
    };
  });

  projected.sort((a, b) => a.testId.localeCompare(b.testId));

  if (options.out) {
    await writeFile(resolve(options.out), JSON.stringify({ tests: projected, errors }, null, 2));
  }

  if (options.json) {
    console.log(JSON.stringify({ tests: projected, errors }, null, 2));
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
}
