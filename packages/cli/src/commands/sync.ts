import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import { loadProjectEnv } from "@glubean/runner";

import { buildProjections } from "./dry-run.js";
import { findProjectConfig } from "./run.js";
import { resolveToken, resolveProjectId, resolveApiUrl } from "../lib/auth.js";
import { resolveEnvFileName } from "../lib/active_env.js";

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  red: "\x1b[31m",
};

/** Strip credential-bearing URL parts (query / fragment / userinfo) before a URL
 *  leaves the machine — mirrors the cloud's server-side sanitizer (defense in
 *  depth: the dry-run projector already placeholders ctx.secrets to `<KEY>`). */
function sanitizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return url.split("#")[0]!.split("?")[0]!.replace(/(\/\/)[^/@]*@/, "$1");
  }
}

export interface SyncCommandOptions {
  dir?: string;
  token?: string;
  project?: string;
  apiUrl?: string;
  tokenEnv?: string;
  envFile?: string;
  /** Allow clearing the project's projections when the repo has 0 tests. */
  allowEmpty?: boolean;
}

/**
 * `glubean sync` — sync the repo's test-definition projections (declared
 * metadata + dry-run shape) to Glubean Cloud for team review. PROJECT-scoped:
 * the projection is generated from SOURCE CODE, so it's one set per codebase
 * regardless of how many targets it runs against. The upload is the COMPLETE
 * source snapshot — the server replaces the project's projections with it
 * (removed tests are deleted). Distinct from `glubean run --upload` (run
 * evidence).
 */
export async function syncCommand(options: SyncCommandOptions = {}): Promise<void> {
  const dir = options.dir ? resolve(options.dir) : process.cwd();
  // Resolve auth/env from the PROJECT ROOT (so root .env.* / .glubean/active-env
  // are honored even when --dir points at a nested scan dir) — parity with run.
  const { rootDir } = await findProjectConfig(dir);

  console.log(`\n${colors.bold}${colors.blue}🔄 Glubean Sync (test-definition projection)${colors.reset}\n`);

  // Validate an EXPLICIT --env-file FIRST — before the (expensive, user-code-
  // running) projection — so a typo fails fast. A missing explicit env file
  // would otherwise load empty and let global/process credentials upload to the
  // WRONG project (parity with run/load). Default: the active env (or .env).
  const userSpecifiedEnvFile = !!options.envFile;
  const envFileName = options.envFile ?? (await resolveEnvFileName(rootDir));
  if (userSpecifiedEnvFile) {
    try {
      await stat(resolve(rootDir, envFileName));
    } catch {
      console.error(`${colors.red}Sync failed: env file '${envFileName}' not found in ${rootDir}${colors.reset}`);
      process.exit(1);
    }
  }

  // ALWAYS project the WHOLE project (rootDir), never just --dir: the upload is a
  // complete snapshot the server replaces, so scanning a subdirectory would make
  // the server delete every test outside it. --dir only locates the project root.
  const { projected, errors } = await buildProjections(rootDir);

  // A file that failed to import / timed out has NO projection. Since sync is a
  // full-snapshot replace, publishing now would DELETE the broken file's tests'
  // projections (treating them as removed) — so abort and let the user fix +
  // re-sync the complete set.
  if (errors.length) {
    console.error(`${colors.red}Sync aborted: ${errors.length} file(s) failed to project.${colors.reset}`);
    for (const e of errors) console.error(`  ${colors.red}✗ ${e.file}: ${e.message}${colors.reset}`);
    console.error(
      `${colors.dim}Fix these files and re-run — syncing now would drop their tests' projections.${colors.reset}`,
    );
    process.exit(1);
  }

  // Empty snapshot would CLEAR the project's projections — guard against an
  // accidental run in the wrong/empty dir; require --allow-empty to actually wipe.
  if (projected.length === 0 && !options.allowEmpty) {
    console.log(
      `${colors.yellow}No simple tests found.${colors.reset} ${colors.dim}Pass --allow-empty to clear the project's projections, or check the directory.${colors.reset}\n`,
    );
    return;
  }

  // Resolve cloud auth — PROJECT-scoped (no target: the projection is repo-level).
  const { vars, secrets } = await loadProjectEnv(rootDir, envFileName);
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
    endpoints: p.endpoints.map((e) => ({ ...e, url: sanitizeUrl(e.url) })),
    assertionCount: p.assertionCount,
    projectionComplete: p.projectionComplete,
    incompleteReason: p.incompleteReason ?? null,
    skipped: p.skipped ?? false,
  }));

  // Redact outbound data before it leaves the machine (parity with run/load):
  // a hardcoded credential in an assertion message / endpoint is masked (URL
  // query/userinfo/fragment is already stripped above). Honor the PROJECT's
  // redaction rules (glubean.yaml `defaults.redaction` — custom sensitiveKeys /
  // customPatterns), not just the built-in defaults; FAIL CLOSED on invalid config.
  const { redactValue } = await import("@glubean/redaction");
  const { loadProjectConfigV1, resolveRedactionConfig } = await import("../lib/config.js");
  let redaction = resolveRedactionConfig(undefined); // built-in defaults
  let hasConfig = false;
  try {
    await stat(resolve(rootDir, "glubean.yaml"));
    hasConfig = true;
  } catch {
    /* no glubean.yaml → built-in default redaction */
  }
  if (hasConfig) {
    try {
      const { config } = await loadProjectConfigV1(rootDir);
      redaction = resolveRedactionConfig(config.defaults?.redaction);
    } catch (err) {
      console.error(
        `${colors.red}Sync failed: invalid glubean.yaml redaction config — ${(err as Error)?.message ?? String(err)}${colors.reset}`,
      );
      process.exit(1);
    }
  }
  const redactField = (v: unknown): unknown =>
    redactValue(v, {
      globalRules: redaction.globalRules,
      replacementFormat: redaction.replacementFormat,
      maxDepth: 64,
    });
  // Redact ONLY the secret-bearing/free-text fields — NEVER `testId` (the stable
  // join key with run evidence; redacting an id that matches a built-in pattern
  // would break correlation and collapse distinct ids) or structural fields
  // (requires/defaultRun/counts/flags).
  const safeBody = {
    tests: tests.map((t) => ({
      ...t,
      description: t.description == null ? t.description : (redactField(t.description) as string),
      deprecated: t.deprecated == null ? t.deprecated : (redactField(t.deprecated) as string),
      incompleteReason:
        t.incompleteReason == null ? t.incompleteReason : (redactField(t.incompleteReason) as string),
      assertions: redactField(t.assertions),
      endpoints: redactField(t.endpoints),
    })),
  };

  const url = `${apiUrl.replace(/\/+$/, "")}/v1/projects/${projectId}/test-projection`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(safeBody),
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

  const result = (await res.json().catch(() => ({}))) as { upserted?: number; deleted?: number };
  const partial = projected.filter((p) => !p.projectionComplete).length;
  const deletedNote = result.deleted ? `${colors.dim} (${result.deleted} removed)${colors.reset}` : "";
  console.log(
    `${colors.green}✓ Synced ${result.upserted ?? tests.length} test projection(s)${colors.reset}${deletedNote} ${colors.dim}to project ${projectId}${colors.reset}`,
  );
  if (partial > 0) {
    console.log(
      `${colors.yellow}  ◐ ${partial} partial (bare branch/loop — use ctx.when()/ctx.switch()/ctx.while() for full projection)${colors.reset}`,
    );
  }
  console.log();
}
