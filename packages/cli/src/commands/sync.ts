import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import { loadProjectEnv } from "@glubean/runner";

import { buildProjections } from "./dry-run.js";
import { findProjectConfig } from "./run.js";
import { resolveToken, resolveProjectId, resolveApiUrl } from "../lib/auth.js";
import { resolveEnvFileName, SensitiveActiveEnvError } from "../lib/active_env.js";

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
  // GLU-88: resolveEnvFileName throws SensitiveActiveEnvError instead of
  // silently returning a prod-like active-env file — surface it as a clear,
  // actionable error (mirrors run/load) rather than silently syncing
  // projections against prod.
  const userSpecifiedEnvFile = !!options.envFile;
  let envFileName: string;
  if (userSpecifiedEnvFile) {
    envFileName = options.envFile!;
  } else {
    try {
      envFileName = await resolveEnvFileName(rootDir);
    } catch (err) {
      if (err instanceof SensitiveActiveEnvError) {
        console.error(`${colors.red}Sync failed: ${err.message}${colors.reset}`);
        process.exit(1);
      }
      throw err;
    }
  }
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
  const { projected, errors, warnings, emptyTestFiles, contracts, workflows, openapi, openapiFailed } =
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
    // B3 T1.5 row provenance — a server that predates the field strips it
    // (ingest zod is non-strict), so this is forward-compatible. NOT redacted
    // below (like testId): idTemplate/rowKey are identity keys built from the
    // same row values as the uploaded testId itself — masking them would break
    // the rowKey === id join Cloud derive performs.
    ...(p.each ? { each: p.each } : {}),
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
  // schemas, node trees) whose object KEYS are mostly field names (e.g. a schema
  // property literally named `password`/`token`) — but it also carries free-form
  // `extensions`/`meta` blobs (scanner's own doc comment warns these "may contain
  // secrets") that CAN hold real credentials, e.g. a cookie-auth contract's
  // default cookie/session-id header value.
  //
  // GLU-123 (Urgent, fixed): this used to redact the projection with
  // `sensitiveKeys: []` (pattern rules only) on the theory that key-based
  // redaction would mask schema field names and corrupt the projection. That
  // theory doesn't hold: `redactValue` runs with `sensitiveKeyRecurse: true`
  // (engine default) — an object/array under a sensitive key is recursed INTO,
  // never replaced wholesale, so only SCALAR leaves get masked and
  // `properties.password: { type: "string" }` keeps its exact shape. Meanwhile
  // clearing sensitiveKeys let `cookie`/`set-cookie`/`sessionid`/`session_id`
  // (not in the built-in pattern set) upload in cleartext. So the projection now
  // reuses the SAME `globalRules` (project sensitiveKeys + built-in scope keys)
  // as every other redacted field — one redaction policy, not a second weaker one.
  //
  // KNOWN BOUNDARY (documented, not new — shared by every redactValue/redactEvent
  // call site in the CLI, e.g. run.ts's live event redaction): a secret nested
  // under a sensitive key but itself keyed by a NON-sensitive inner name (e.g.
  // `extensions: { cookie: { value: "sid=…" } }` instead of the natural
  // `extensions: { cookie: "sid=…" }`) is NOT auto-masked — only the direct
  // scalar under the sensitive key is. Closing this would require the engine to
  // treat every descendant of a sensitive key as sensitive too, which would ALSO
  // re-mask the `properties.password: { type: "string" }` schema metadata this
  // fix just stopped corrupting — the two goals conflict without a schema-vs-
  // free-form distinction the engine doesn't have today. Out of scope for this
  // Urgent fix (which closes the confirmed direct-value leak); tracked as a
  // follow-up if an author is found wrapping extension/meta secrets this way.
  const redactStructure = redactField;
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
  // The OpenAPI doc is purely structural (paths + schemas) but, like the
  // normalized projection above, can carry real secrets in examples/default
  // values — same `redactStructure` (full key + pattern policy), same
  // shape-preserving guarantee for schema field names. `null` when there are
  // no HTTP contracts, so a full-replace clears any stale doc.
  const safeOpenapi = openapi ? (redactStructure(openapi) as Record<string, unknown>) : null;

  const base = `${apiUrl.replace(/\/+$/, "")}/v1/projects/${projectId}/projections`;
  // Each kind is its OWN full-snapshot replace (an empty kind clears that kind's
  // stale projections). POST all three; a failure on any aborts.
  const post = async (
    kind: string,
    body: unknown,
    opts?: { tolerateMissingRoute?: boolean },
  ): Promise<{ upserted?: number; deleted?: number; skipped?: boolean }> => {
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
      // A server that predates this projection kind answers 404 — tolerate it (skip
      // this kind) instead of failing a sync that already replaced the OTHER kinds, so
      // a newer CLI keeps working against a not-yet-upgraded / self-hosted server.
      if (opts?.tolerateMissingRoute && res.status === 404) return { skipped: true };
      const text = await res.text().catch(() => "");
      console.error(`${colors.red}Sync failed (${kind}): ${res.status} ${text}${colors.reset}`);
      if (res.status === 401 || res.status === 403) {
        console.error(
          `${colors.dim}The token is invalid/expired or lacks runs:write. Create a project token in the dashboard and 'glubean login' (or set GLUBEAN_TOKEN).${colors.reset}`,
        );
      }
      process.exit(1);
    }
    return (await res.json().catch(() => ({}))) as { upserted?: number; deleted?: number; skipped?: boolean };
  };

  const testRes = await post("test", { tests: safeTests });
  const contractRes = await post("contract", { contracts: safeContracts });
  const workflowRes = await post("workflow", { workflows: safeWorkflows });
  // The OpenAPI doc is a project-level single snapshot (not a per-id replace) — one
  // doc rendered from all HTTP contracts. POST it last; `null` clears a stale doc. Two
  // ways it skips (best-effort, never aborts the whole sync): render FAILED (don't wipe
  // a prior doc on a transient error), or the server predates the route (404 tolerated,
  // so a newer CLI doesn't break sync against a not-yet-upgraded server).
  const openapiRes = openapiFailed
    ? { skipped: true as const }
    : await post("openapi", { openapi: safeOpenapi }, { tolerateMissingRoute: true });

  const line = (label: string, r: { upserted?: number; deleted?: number }, n: number) => {
    const removed = r.deleted ? `${colors.dim} (${r.deleted} removed)${colors.reset}` : "";
    return `${colors.green}✓ ${r.upserted ?? n} ${label}${colors.reset}${removed}`;
  };
  const pathCount = safeOpenapi ? Object.keys((safeOpenapi.paths as Record<string, unknown>) ?? {}).length : 0;
  const openapiLine = openapiFailed
    ? `${colors.yellow}⚠ openapi skipped (render failed; kept previous)${colors.reset}`
    : openapiRes?.skipped
      ? `${colors.dim}· openapi not supported by this server (skipped)${colors.reset}`
      : `${colors.green}✓ openapi${colors.reset}${colors.dim} (${pathCount} path${pathCount === 1 ? "" : "s"})${colors.reset}`;
  console.log(
    `${line("test", testRes, safeTests.length)}  ${line("contract", contractRes, safeContracts.length)}  ${line("workflow", workflowRes, safeWorkflows.length)}  ${openapiLine} ${colors.dim}→ project ${projectId}${colors.reset}`,
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
