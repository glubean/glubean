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
  const { projected, errors, warnings, emptyTestFiles, contracts, workflows } =
    await buildProjections(rootDir);

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

  // A file the SCANNER couldn't turn into a projection is dropped BEFORE upload
  // (it never shows in `errors`), yet its tests/contracts/workflows would vanish
  // from this full snapshot and be DELETED on replace. All fatal: test extraction
  // THREW ("Failed to extract metadata from"), a test file yielded ZERO exports
  // (emptyTestFiles), or a contract/workflow file failed to import ("Contract
  // import failed" / "Flow import failed" — leaves contractsProjection/workflows
  // missing that file, so a full-replace would wipe its prior Cloud projection).
  const dropped = [
    ...warnings.filter(
      (w) =>
        w.startsWith("Failed to extract metadata from") ||
        w.startsWith("Contract import failed") ||
        w.startsWith("Flow import failed"),
    ),
    ...emptyTestFiles.map(
      (f) => `${f} — a Glubean test file with no extractable tests (syntax error, or tests removed/unrecognized?)`,
    ),
  ];
  if (dropped.length) {
    console.error(`${colors.red}Sync aborted: ${dropped.length} file(s) would be dropped from the snapshot.${colors.reset}`);
    for (const w of dropped) console.error(`  ${colors.red}✗ ${w}${colors.reset}`);
    console.error(
      `${colors.dim}Fix these files and re-run — syncing now would delete their projections from Cloud.${colors.reset}`,
    );
    process.exit(1);
  }

  // Empty snapshot would CLEAR the project's projections — guard against an
  // accidental run in the wrong/empty dir; require --allow-empty to actually wipe.
  // "Empty" means NO specs of ANY kind (test + contract + workflow).
  if (projected.length === 0 && contracts.length === 0 && workflows.length === 0 && !options.allowEmpty) {
    console.log(
      `${colors.yellow}No tests, contracts, or workflows found.${colors.reset} ${colors.dim}Pass --allow-empty to clear the project's projections, or check the directory.${colors.reset}\n`,
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
    tags: p.tags ?? [],
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
  const { redactValue, BUILTIN_SCOPES } = await import("@glubean/redaction");
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
  // The projection is a static blob with NO request/response scope to bind to, so
  // fold the builtin SCOPE sensitive keys (cookie / set-cookie / authorization /
  // token / …) into the global keys — otherwise header/query examples carried in a
  // contract/workflow projection would upload in cleartext (run/load apply these
  // per-scope; here there's no scope, so apply them everywhere).
  const scopeKeys = [...new Set(BUILTIN_SCOPES.flatMap((s) => s.rules?.sensitiveKeys ?? []))];
  const globalRules = {
    ...redaction.globalRules,
    sensitiveKeys: [...new Set([...(redaction.globalRules.sensitiveKeys ?? []), ...scopeKeys])],
  };
  const redactField = (v: unknown): unknown =>
    redactValue(v, {
      globalRules,
      replacementFormat: redaction.replacementFormat,
      maxDepth: 64,
    });
  // The normalized contract/workflow `projection` is a TYPE/STRUCTURE blob (JSON
  // schemas, node trees) — its object KEYS are field names (e.g. a schema property
  // literally named `password`/`token`), NOT secrets. Key-based redaction would
  // MASK those field names and destroy the schema projection — the most important
  // part of a contract. So redact the projection with PATTERN rules ONLY (still
  // catches secret-LOOKING literal values, e.g. a hardcoded `sk-…` default), never
  // sensitiveKeys.
  const structureRules = { ...redaction.globalRules, sensitiveKeys: [] };
  const redactStructure = (v: unknown): unknown =>
    redactValue(v, {
      globalRules: structureRules,
      replacementFormat: redaction.replacementFormat,
      maxDepth: 64,
    });
  // Redact ONLY the secret-bearing/free-text fields — NEVER `testId` (the stable
  // join key with run evidence; redacting an id that matches a built-in pattern
  // would break correlation and collapse distinct ids) or structural fields
  // (requires/defaultRun/counts/flags).
  const safeTests = tests.map((t) => ({
    ...t,
    description: t.description == null ? t.description : (redactField(t.description) as string),
    deprecated: t.deprecated == null ? t.deprecated : (redactField(t.deprecated) as string),
    incompleteReason:
      t.incompleteReason == null ? t.incompleteReason : (redactField(t.incompleteReason) as string),
    assertions: redactField(t.assertions),
    endpoints: redactField(t.endpoints),
  }));
  // Contracts/workflows: redact the free-text + the normalized `projection` body
  // (schemas/descriptions/notes), preserve identity/structural fields.
  const safeContracts = contracts.map((c) => ({
    contractId: c.contractId,
    protocol: c.protocol,
    target: c.target ?? null,
    description: c.description == null ? null : (redactField(c.description) as string),
    deprecated: c.deprecated == null ? null : (redactField(c.deprecated) as string),
    tags: c.tags ?? [],
    caseCount: c.caseCount,
    projection: redactStructure(c.projection),
    projectionComplete: c.projectionComplete,
    incompleteReason: c.incompleteReason ?? null,
  }));
  const safeWorkflows = workflows.map((w) => ({
    workflowId: w.workflowId,
    name: w.name ?? null,
    description: w.description == null ? null : (redactField(w.description) as string),
    tags: w.tags ?? [],
    nodeCount: w.nodeCount,
    projection: redactStructure(w.projection),
    projectionComplete: w.projectionComplete,
    incompleteReason: w.incompleteReason ?? null,
  }));

  const base = `${apiUrl.replace(/\/+$/, "")}/v1/projects/${projectId}/projections`;
  // Each kind is its OWN full-snapshot replace (an empty kind clears that kind's
  // stale projections). POST all three; a failure on any aborts.
  const post = async (kind: string, body: unknown): Promise<{ upserted?: number; deleted?: number }> => {
    let res: Response;
    try {
      res = await fetch(`${base}/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
    } catch (err) {
      console.error(`${colors.red}Sync failed (${kind}): ${(err as Error)?.message ?? String(err)}${colors.reset}`);
      process.exit(1);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`${colors.red}Sync failed (${kind}): ${res.status} ${text}${colors.reset}`);
      if (res.status === 401 || res.status === 403) {
        console.error(
          `${colors.dim}The token is invalid/expired or lacks runs:write. Create a project token in the dashboard and 'glubean login' (or set GLUBEAN_TOKEN).${colors.reset}`,
        );
      }
      process.exit(1);
    }
    return (await res.json().catch(() => ({}))) as { upserted?: number; deleted?: number };
  };

  const testRes = await post("test", { tests: safeTests });
  const contractRes = await post("contract", { contracts: safeContracts });
  const workflowRes = await post("workflow", { workflows: safeWorkflows });

  const line = (label: string, r: { upserted?: number; deleted?: number }, n: number) => {
    const removed = r.deleted ? `${colors.dim} (${r.deleted} removed)${colors.reset}` : "";
    return `${colors.green}✓ ${r.upserted ?? n} ${label}${colors.reset}${removed}`;
  };
  console.log(
    `${line("test", testRes, safeTests.length)}  ${line("contract", contractRes, safeContracts.length)}  ${line("workflow", workflowRes, safeWorkflows.length)} ${colors.dim}→ project ${projectId}${colors.reset}`,
  );
  const partial =
    projected.filter((p) => !p.projectionComplete).length +
    contracts.filter((c) => !c.projectionComplete).length +
    workflows.filter((w) => !w.projectionComplete).length;
  if (partial > 0) {
    console.log(
      `${colors.yellow}  ◐ ${partial} partial — use ctx.when()/switch()/while() (tests) or resolve opaque nodes/unprojectable schemas (workflows/contracts) for full projection${colors.reset}`,
    );
  }
  console.log();
}
