import { resolve, relative } from "node:path";
import { stat } from "node:fs/promises";
import { loadProjectEnv } from "@glubean/runner";

import { buildProjections } from "./dry-run.js";
import { findProjectConfig } from "./run.js";
import {
  resolveToken,
  resolveProjectId,
  resolveApiUrl,
  PLATFORM_API_URL_UNRESOLVED_HINT,
} from "../lib/auth.js";
import { resolveEnvFileName, SensitiveActiveEnvError } from "../lib/active_env.js";
import { detectGitProvenance, gitRoot } from "../lib/git.js";
import { formatProjectionInventory } from "../lib/feedback.js";

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

/** A single hand-authored contract declaration beyond this is pathological
 * (generated code, a pasted fixture) — its source stops being review material. */
const SOURCE_TEXT_MAX_PER_CONTRACT_BYTES = 64 * 1024;
/** Safety margin under the platform contract-projection route's 8 MiB
 * `MAX_BODY_BYTES` — leaves headroom for the envelope (git provenance, JSON
 * syntax) so the budget check can measure `{ contracts }` alone. */
const CONTRACTS_BODY_SAFE_BYTES = 7 * 1024 * 1024;

/**
 * Drop `projection.sourceText` when the contracts POST body would exceed the
 * server's cap. The verbatim source is a review EXTRA — it must never be what
 * turns a large-but-valid project into a 413 that can't sync at all; structured
 * projections are never dropped.
 *
 * ALL-OR-NOTHING by design (codex R4 P2): Cloud versions each contract by
 * hashing its whole `projection`, so SELECTIVELY dropping source (largest-first)
 * would let an unrelated contract's growth strip a DIFFERENT, unchanged
 * contract's source — appending a false revision and churning its review-note
 * hash. Including source for every contract or none keeps each contract's
 * payload a function of the project state the author actually changed, at the
 * cost of one collective flip on the (pathological) project that crosses the
 * boundary. The per-contract cap stays: it depends only on the contract's OWN
 * span, so it can never churn a neighbor.
 *
 * Mutates in place; returns how many contracts had their source omitted HERE
 * (capture-time omissions carry their own marker — see `sourceTextOmitted`).
 * Exported for tests.
 */
export function applySourceTextBudget(
  contracts: Array<{ projection: unknown }>,
  perContractMax = SOURCE_TEXT_MAX_PER_CONTRACT_BYTES,
  bodySafeBytes = CONTRACTS_BODY_SAFE_BYTES,
): number {
  const carriers = contracts
    .map((c) => c.projection)
    .filter(
      (p): p is Record<string, unknown> =>
        p !== null && typeof p === "object" && !Array.isArray(p) && typeof (p as Record<string, unknown>).sourceText === "string",
    );
  let omitted = 0;
  const drop = (p: Record<string, unknown>) => {
    delete p.sourceText;
    omitted++;
  };
  for (const p of carriers) {
    if (Buffer.byteLength(p.sourceText as string, "utf8") > perContractMax) drop(p);
  }
  const bodyBytes = Buffer.byteLength(JSON.stringify({ contracts }), "utf8");
  if (bodyBytes > bodySafeBytes) {
    for (const p of carriers) {
      if (typeof p.sourceText === "string") drop(p);
    }
  }
  return omitted;
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
  const { projected, files, errors, warnings, emptyTestFiles, contracts, workflows, openapi, openapiFailed } =
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

  console.log(formatProjectionInventory("Discovered locally", {
    files: files.length,
    tests: projected.length,
    contracts: contracts.length,
    workflows: workflows.length,
    warnings: warnings.length,
  }, { hintWhenNoWorkflows: true }));
  console.log();

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
    console.error(`${colors.red}Sync failed: could not determine the Platform API URL.${colors.reset}`);
    console.error(`${colors.dim}${PLATFORM_API_URL_UNRESOLVED_HINT}${colors.reset}`);
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
  // (the `RedactionEngine` constructor itself defaults this to false;
  // `redactValue`/`compiler.ts` opts into true for non-event payloads like
  // this projection) — an object/array under a sensitive key is recursed INTO,
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
  // GLU-221 phase 1 — local git provenance (repo/commit/branch), independent
  // of CI (`sync` runs from a developer machine as often as from CI). A
  // contract's source position is only useful to Cloud alongside a
  // resolvable repo identity. Best-effort: `detectGitProvenance`/`gitRoot`
  // fail closed to `null` on every boundary case (no git, no remote,
  // non-GitHub remote, zero-commit repo) rather than throwing — sync must
  // never abort over this.
  const gitInfo = await detectGitProvenance(rootDir);
  // A contract's `sourceFile` (from the scanner) is relative to `rootDir` —
  // the directory that was scanned — which, in a monorepo, can be a
  // SUBDIRECTORY of the git repo root. Rebase onto the repo root so a future
  // Cloud deep link resolves against the actual GitHub tree, not the
  // scanned subpath.
  const repoRootAbs = gitInfo ? await gitRoot(rootDir) : null;
  const toRepoRelativeSourceFile = (sourceFile?: string): string | null => {
    if (!sourceFile) return null;
    if (!repoRootAbs) return sourceFile;
    return relative(repoRootAbs, resolve(rootDir, sourceFile));
  };
  // GLU-221 phase 1 P2-2 fix — `c.sourceFile` (the TOP-LEVEL `ProjectedContract`
  // field, rebased just above) is a SEPARATE copy from the `sourceFile` embedded
  // inside `c.projection` (the scanner's `NormalizedContractMeta`, uploaded
  // verbatim below as the reviewable projection body) at BOTH the contract level
  // (`projection.sourceFile`) and the per-case level (`projection.cases[].sourceFile`
  // — see `NormalizedCaseMeta.sourceFile`). In a monorepo where `rootDir` is a
  // subdirectory of the git repo, only the top-level field was being rebased;
  // anything reading the embedded projection/case `sourceFile` directly (e.g. a
  // future Cloud per-case deep link) would resolve against the WRONG path
  // (project-root-relative, not repo-root-relative). Apply the SAME rebase here.
  const rebaseEmbeddedSourceFiles = (projection: unknown): unknown => {
    if (!projection || typeof projection !== "object") return projection;
    const p = projection as { sourceFile?: unknown; cases?: unknown };
    const rebased: Record<string, unknown> = { ...(projection as Record<string, unknown>) };
    if (typeof p.sourceFile === "string") {
      rebased.sourceFile = toRepoRelativeSourceFile(p.sourceFile) ?? undefined;
    }
    if (Array.isArray(p.cases)) {
      rebased.cases = p.cases.map((cs) =>
        cs && typeof cs === "object" && typeof (cs as { sourceFile?: unknown }).sourceFile === "string"
          ? {
              ...(cs as Record<string, unknown>),
              sourceFile: toRepoRelativeSourceFile((cs as { sourceFile: string }).sourceFile) ?? undefined,
            }
          : cs,
      );
    }
    return rebased;
  };

  // Attach the contract's raw authored source to the (already redacted) projection
  // body. Held out of redaction on purpose: the source span is clean by authoring
  // convention (secrets live in env vars / out-of-span consts — a skill rule), and
  // pattern redaction would corrupt otherwise-valid TypeScript. Rides inside
  // `projection` (not a top-level sibling) so the server's `z.unknown()` projection
  // field carries it through ingest → JSONB → read with no server changes.
  const withSourceText = (projection: unknown, sourceText: string | undefined): unknown =>
    sourceText !== undefined && projection !== null && typeof projection === "object" && !Array.isArray(projection)
      ? { ...(projection as Record<string, unknown>), sourceText }
      : projection;

  // The source is an EXTRA on top of the structured snapshot — it must never be
  // what tips a large project's contracts POST over the server's body cap into a
  // 413 "can't sync at all" (codex R1 P2). Budgeted after assembly, see
  // applySourceTextBudget below; the structured projections are never dropped.

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
    projection: withSourceText(redactStructure(rebaseEmbeddedSourceFiles(c.projection)), c.sourceText),
    projectionComplete: c.projectionComplete,
    incompleteReason: c.incompleteReason ?? null,
    // GLU-221 phase 1 — best-effort source location (structural identity
    // fields, like `contractId` above — never redacted). `null` when the
    // scanner couldn't statically resolve them (scoped/custom factory
    // contracts, or a contract file outside any git repo).
    sourceFile: toRepoRelativeSourceFile(c.sourceFile),
    line: c.line ?? null,
    endLine: c.endLine ?? null,
  }));
  // Omissions the author should hear about (never silent): spans the SCANNER
  // withheld at capture (per-contract cap — carried as a marker in the meta,
  // codex R4 P3) plus any stripped here by the payload budget.
  const captureOmitted = safeContracts.filter(
    (c) =>
      c.projection !== null &&
      typeof c.projection === "object" &&
      (c.projection as Record<string, unknown>).sourceTextOmitted === true,
  ).length;
  const sourceTextOmitted = captureOmitted + applySourceTextBudget(safeContracts);
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
  ): Promise<{ upserted?: number; deleted?: number; skipped?: boolean; url?: string }> => {
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
      console.error(`${colors.dim}Sync POST: ${base}/${kind}${colors.reset}`);
      if (res.status === 401 || res.status === 403) {
        console.error(
          `${colors.dim}The token is invalid/expired or lacks runs:write. Create a project token in the dashboard and 'glubean login' (or set GLUBEAN_TOKEN).${colors.reset}`,
        );
      } else if (res.status === 404) {
        // GLU-161: the #1 cause is --api-url / GLUBEAN_PLATFORM_API_URL /
        // GLUBEAN_API_URL resolving to the Dashboard/session-auth host
        // (server-hono, no `/v1/*` routes) instead of the Platform ingest API
        // `sync` requires — same trap `run --upload` / `load --upload`
        // preflight already surface, but sync has no preflight GET so this is
        // the first place it's diagnosable.
        console.error(
          `${colors.dim}Check that --api-url / GLUBEAN_PLATFORM_API_URL (or GLUBEAN_API_URL) points at the platform ingest API (the token-only \`/v1/*\` service) — not a dashboard/session-auth host, which has no \`/v1\` routes and 404s here too.${colors.reset}`,
        );
      }
      process.exit(1);
    }
    return (await res.json().catch(() => ({}))) as {
      upserted?: number;
      deleted?: number;
      skipped?: boolean;
      url?: string;
    };
  };

  const testRes = await post("test", { tests: safeTests });
  // GLU-221 phase 1 — git provenance travels at the contract-kind top level
  // (siblings the same full-snapshot-replace body as `contracts`), not
  // per-contract: one repo/commit/branch describes the whole sync, same as
  // `contracts`/`workflows` are each project-level snapshots.
  const contractRes = await post("contract", { contracts: safeContracts, git: gitInfo ?? null });
  const workflowRes = await post("workflow", { workflows: safeWorkflows });
  // The OpenAPI doc is a project-level single snapshot (not a per-id replace) — one
  // doc rendered from all HTTP contracts. POST it last; `null` clears a stale doc. Two
  // ways it skips (best-effort, never aborts the whole sync): render FAILED (don't wipe
  // a prior doc on a transient error), or the server predates the route (404 tolerated,
  // so a newer CLI doesn't break sync against a not-yet-upgraded server).
  const openapiRes = openapiFailed
    ? { skipped: true as const }
    : await post("openapi", { openapi: safeOpenapi }, { tolerateMissingRoute: true });

  const line = (label: string, r: { upserted?: number; deleted?: number }, expected: number) => {
    const confirmed = r.upserted ?? expected;
    const mismatch = r.upserted !== undefined && r.upserted !== expected;
    const mark = mismatch ? `${colors.yellow}!${colors.reset}` : `${colors.green}✓${colors.reset}`;
    const removed = r.deleted ? `${colors.dim}; ${r.deleted} removed${colors.reset}` : "";
    const detail = mismatch
      ? `${colors.yellow}; expected ${expected} from local discovery${colors.reset}`
      : "";
    return `  ${mark} ${label.padEnd(10)} ${String(confirmed).padStart(5)}${removed}${detail}`;
  };
  const pathCount = safeOpenapi ? Object.keys((safeOpenapi.paths as Record<string, unknown>) ?? {}).length : 0;
  const openapiLine = openapiFailed
    ? `${colors.yellow}⚠ openapi skipped (render failed; kept previous)${colors.reset}`
    : openapiRes?.skipped
      ? `${colors.dim}· openapi not supported by this server (skipped)${colors.reset}`
      : `${colors.green}✓ openapi${colors.reset}${colors.dim} (${pathCount} path${pathCount === 1 ? "" : "s"})${colors.reset}`;
  console.log(`${colors.bold}Cloud confirmed${colors.reset}`);
  console.log(line("Tests", testRes, safeTests.length));
  console.log(line("Contracts", contractRes, safeContracts.length));
  console.log(line("Workflows", workflowRes, safeWorkflows.length));
  console.log(`  ${openapiLine}`);

  const openapiUrl = "url" in openapiRes ? openapiRes.url : undefined;
  const urls = [testRes.url, contractRes.url, workflowRes.url, openapiUrl]
    .filter((url): url is string => typeof url === "string" && url.length > 0);
  const uniqueUrls = [...new Set(urls)];
  if (uniqueUrls.length === 1) {
    console.log(`\n${colors.bold}View project${colors.reset}`);
    console.log(`  ${uniqueUrls[0]}`);
  } else if (uniqueUrls.length === 0) {
    console.log(
      `\n${colors.yellow}Cloud did not return an app URL.${colors.reset} ${colors.dim}Update the Platform API; the CLI will not guess app routes.${colors.reset}`,
    );
  } else {
    console.log(
      `\n${colors.yellow}Cloud returned inconsistent app URLs.${colors.reset} ${colors.dim}${uniqueUrls.join(", ")}${colors.reset}`,
    );
  }
  const partial =
    projected.filter((p) => !p.projectionComplete).length +
    contracts.filter((c) => !c.projectionComplete).length +
    workflows.filter((w) => !w.projectionComplete).length;
  if (partial > 0) {
    console.log(
      `${colors.yellow}  ◐ ${partial} partial — use ctx.when()/switch()/while() (tests) or resolve opaque nodes/unprojectable schemas (workflows/contracts) for full projection${colors.reset}`,
    );
  }
  if (sourceTextOmitted > 0) {
    // Never silent: the Specs "Source" view will be missing for these, and the
    // author should know it was a size budget, not a capture failure.
    console.log(
      `${colors.yellow}  ◐ source omitted for ${sourceTextOmitted} contract(s) — payload size budget (structured projections still synced)${colors.reset}`,
    );
  }
  console.log();
}
