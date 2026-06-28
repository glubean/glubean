import { resolve } from "node:path";
import { loadProjectEnv } from "@glubean/runner";

import { buildProjections } from "./dry-run.js";
import { resolveToken, resolveProjectId, resolveApiUrl } from "../lib/auth.js";

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  red: "\x1b[31m",
};

export interface SyncCommandOptions {
  dir?: string;
  token?: string;
  project?: string;
  apiUrl?: string;
  tokenEnv?: string;
  envFile?: string;
}

/**
 * `glubean sync` — sync the repo's test-definition projections (declared
 * metadata + dry-run shape) to Glubean Cloud for team review. PROJECT-scoped:
 * the projection is generated from SOURCE CODE, so it's one set per codebase
 * regardless of how many targets it runs against (latest-wins upsert). Distinct
 * from `glubean run --upload`, which uploads a target's run EVIDENCE.
 */
export async function syncCommand(options: SyncCommandOptions = {}): Promise<void> {
  const dir = options.dir ? resolve(options.dir) : process.cwd();

  console.log(`\n${colors.bold}${colors.blue}🔄 Glubean Sync (test-definition projection)${colors.reset}\n`);
  const { projected, errors } = await buildProjections(dir);

  if (errors.length) {
    console.log(`${colors.yellow}Import errors (these tests were skipped):${colors.reset}`);
    for (const e of errors) console.log(`  ${colors.yellow}✗ ${e.file}: ${e.message}${colors.reset}`);
    console.log();
  }

  if (projected.length === 0) {
    console.log(`${colors.yellow}No simple tests found to sync.${colors.reset}\n`);
    return;
  }

  // Resolve cloud auth — PROJECT-scoped (no target: the projection is repo-level).
  const envFileName = options.envFile ?? ".env";
  const { vars, secrets } = await loadProjectEnv(dir, envFileName);
  const authOpts = { token: options.token, project: options.project, apiUrl: options.apiUrl };
  const sources = { envFileVars: { ...vars, ...secrets } };
  const token = await resolveToken(authOpts, sources, options.tokenEnv);
  const projectId = await resolveProjectId(authOpts, sources);
  const apiUrl = await resolveApiUrl(authOpts, sources);

  if (!token) {
    console.error(
      `${colors.red}Sync failed: no auth token.${colors.reset}\n` +
        `${colors.dim}Create a project token (glb_…) in the dashboard (Project → Tokens), then run 'glubean login', set GLUBEAN_TOKEN / --token, or add it to .env.secrets.${colors.reset}`,
    );
    process.exit(1);
  }
  if (!projectId) {
    console.error(
      `${colors.red}Sync failed: no project ID.${colors.reset}\n` +
        `${colors.dim}Set --project / GLUBEAN_PROJECT_ID, or run 'glubean login'.${colors.reset}`,
    );
    process.exit(1);
  }
  if (!apiUrl) {
    console.error(`${colors.red}Sync failed: no API URL (set --api-url / GLUBEAN_API_URL).${colors.reset}`);
    process.exit(1);
  }

  const tests = projected.map((p) => ({
    testId: p.testId,
    description: p.description ?? null,
    deprecated: p.deprecated ?? null,
    requires: p.requires ?? null,
    defaultRun: p.defaultRun ?? null,
    assertions: p.assertions,
    endpoints: p.endpoints,
    assertionCount: p.assertionCount,
    projectionComplete: p.projectionComplete,
    incompleteReason: p.incompleteReason ?? null,
    skipped: p.skipped ?? false,
  }));

  const url = `${apiUrl.replace(/\/+$/, "")}/v1/projects/${projectId}/test-projection`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ tests }),
    });
  } catch (err) {
    console.error(`${colors.red}Sync failed: ${(err as Error)?.message ?? String(err)}${colors.reset}`);
    process.exit(1);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`${colors.red}Sync failed: ${res.status} ${body}${colors.reset}`);
    if (res.status === 401 || res.status === 403) {
      console.error(
        `${colors.dim}The token is invalid/expired or lacks runs:write. Create a project token in the dashboard and 'glubean login' (or set GLUBEAN_TOKEN).${colors.reset}`,
      );
    }
    process.exit(1);
  }

  const result = (await res.json().catch(() => ({}))) as { upserted?: number };
  const partial = projected.filter((p) => !p.projectionComplete).length;
  console.log(
    `${colors.green}✓ Synced ${result.upserted ?? tests.length} test projection(s)${colors.reset} ${colors.dim}to project ${projectId}${colors.reset}`,
  );
  if (partial > 0) {
    console.log(
      `${colors.yellow}  ◐ ${partial} partial (bare branch/loop — use ctx.when()/ctx.switch()/ctx.while() for full projection)${colors.reset}`,
    );
  }
  console.log();
}
