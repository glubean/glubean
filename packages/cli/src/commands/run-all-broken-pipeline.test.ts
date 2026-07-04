/**
 * GLU-194 — GLU-155 follow-up: the "all-broken" 0-test early-exit must flow
 * through the SAME `--result-json` / `--reporter junit` / `--upload` pipeline
 * a MIXED discovery-failure run already gets (GLU-155).
 *
 * Before this fix, when EVERY targeted contract/test file failed to import,
 * `run.ts` took the `allFileTests.length === 0` early-exit branch: it printed
 * the discovery-failure diagnostics, persisted a minimal
 * `.glubean/last-run.result.json`, and called `process.exit(1)` — WITHOUT
 * ever reaching the `--result-json` write, the `--reporter junit` write, or
 * the `--upload` block. A CI job wired for `--result-json`/junit ingestion or
 * `--upload` got NOTHING for this run, even though the run genuinely failed.
 *
 * The MIXED case (some files import fine, at least one test is discovered)
 * already reaches the full pipeline — this file proves the ALL-BROKEN case
 * now does too, with the run correctly marked failed + `discoveryFailures`
 * attached, not silently dropped or misreported as passed/empty.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";
import { runCli } from "../test-helpers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(HERE, "..", "..", ".tmp-run-all-broken-pipeline");
let fixtureSeq = 0;

async function prepareFixture(
  name: string,
  files: Record<string, string>,
): Promise<string> {
  fixtureSeq += 1;
  const dir = join(FIXTURE_ROOT, `${name}-${fixtureSeq}`);
  await mkdir(dir, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf-8");
  }
  return dir;
}

afterAll(async () => {
  await rm(FIXTURE_ROOT, { recursive: true, force: true });
});

function workspacePackageJson(name: string): string {
  return JSON.stringify(
    { name, type: "module", version: "0.0.0", dependencies: { "@glubean/sdk": "workspace:*" } },
    null,
    2,
  );
}

// Two contract files, BOTH failing to import — needs isMultiFile (testFiles.length
// > 1) so the loop aggregates instead of a single-file target's separate
// immediate-exit-in-catch path (which stays out of GLU-194's scope — see run.ts).
const BROKEN_CONTRACT = `
import { configure, contract } from "@glubean/sdk";

const { vars } = configure({ vars: { base: "{{base_url}}" } });
const leaked = vars.base; // throws at import time — not inside a test/case

const api = contract.http.with("brokenApi", { endpoint: leaked });

export const ping = api("broken.ping", {
  endpoint: "GET /ping",
  cases: { ok: { description: "ok", expect: { status: 200 } } },
});
`;

async function prepareAllBroken(name: string): Promise<string> {
  return prepareFixture(name, {
    "package.json": workspacePackageJson(`glu194-${name}`),
    "contracts/broken.contract.ts": BROKEN_CONTRACT,
    "contracts/broken-2.contract.ts": BROKEN_CONTRACT.replace("brokenApi", "brokenApi2"),
  });
}

test(
  "glubean run: an all-broken run still writes --result-json AND --reporter junit (GLU-194)",
  async () => {
    const dir = await prepareAllBroken("result-junit");

    const { code, stdout, stderr } = await runCli(
      [
        "run",
        "contracts/",
        "--result-json",
        "result.json",
        "--reporter",
        "junit",
      ],
      { cwd: dir },
    );
    const out = stdout + stderr;

    // Still fails closed, same as before this fix.
    expect(code).not.toBe(0);
    expect(out).toContain("Discovery:");
    expect(out).toMatch(/2 file\(s\) failed to import/);

    // `.glubean/last-run.result.json` — unconditional sink, already worked
    // pre-GLU-194 (GLU-155 R2 P2), still must work.
    const lastRun = JSON.parse(
      await readFile(join(dir, ".glubean", "last-run.result.json"), "utf-8"),
    );
    expect(lastRun.discoveryFailures).toHaveLength(2);
    expect(lastRun.tests).toEqual([]);
    expect(lastRun.summary).toMatchObject({ total: 0, passed: 0, failed: 0 });

    // `--result-json result.json` — THE GAP: this used to never be written
    // for an all-broken run (the early-exit branch returned before reaching
    // the `options.resultJson` block at all).
    expect(out).toContain("Result written to");
    const resultJsonContent = JSON.parse(
      await readFile(join(dir, "result.json"), "utf-8"),
    );
    expect(resultJsonContent.discoveryFailures).toHaveLength(2);
    const failedPaths = resultJsonContent.discoveryFailures
      .map((d: { filePath: string }) => d.filePath)
      .sort();
    expect(failedPaths).toEqual([
      "contracts/broken-2.contract.ts",
      "contracts/broken.contract.ts",
    ]);
    expect(resultJsonContent.tests).toEqual([]);

    // `--reporter junit` — THE OTHER GAP: same story, never written before.
    // Codex xhigh review (P2): a CI job gating on the JUnit `failures` count
    // must NOT see a clean 0-failure suite for a run that exited non-zero —
    // each import failure renders as its own synthetic failing testcase.
    expect(out).toContain("JUnit XML written to");
    const junitContent = await readFile(
      join(dir, "glubean-run.junit.xml"),
      "utf-8",
    );
    expect(junitContent).toContain("<?xml");
    expect(junitContent).toContain('tests="2"');
    expect(junitContent).toContain('failures="2"');
    expect(junitContent).toContain("contracts/broken.contract.ts");
    expect(junitContent).toContain("contracts/broken-2.contract.ts");
    expect(junitContent.match(/<failure /g) ?? []).toHaveLength(2);
  },
  30_000,
);

test(
  "glubean run: an all-broken run combined with --input-json still reaches --result-json instead of exiting on the exact-one-test check (GLU-194 codex xhigh P3)",
  async () => {
    const dir = await prepareAllBroken("input-json");

    const { code, stdout, stderr } = await runCli(
      [
        "run",
        "contracts/",
        "--input-json",
        '{"anything":true}',
        "--result-json",
        "result.json",
      ],
      { cwd: dir },
    );
    const out = stdout + stderr;

    expect(code).not.toBe(0);
    // Must NOT hit the exact-one-test validation message — that would mean
    // the run exited before the result pipeline again.
    expect(out).not.toContain("require --filter to match exactly one testId");
    expect(out).toContain("Result written to");

    const resultJsonContent = JSON.parse(
      await readFile(join(dir, "result.json"), "utf-8"),
    );
    expect(resultJsonContent.discoveryFailures).toHaveLength(2);
  },
  30_000,
);

/** Minimal fake Glubean Platform API — just enough of the `/v1/*` surface for
 *  the CLI's upload preflight (project + explicit target check) and the run
 *  ingest POST. Captures every ingest body it receives for assertions. */
function startFakePlatform(): Promise<{
  baseUrl: string;
  close: () => void;
  ingestedBodies: Array<Record<string, unknown>>;
}> {
  const ingestedBodies: Array<Record<string, unknown>> = [];
  return new Promise((resolvePromise, reject) => {
    const server: Server = createServer(
      (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const projectMatch = /^\/v1\/projects\/([^/]+)$/.exec(url.pathname);
        const targetMatch = /^\/v1\/projects\/([^/]+)\/targets\/([^/]+)$/.exec(
          url.pathname,
        );
        const runsMatch = /^\/v1\/projects\/([^/]+)\/targets\/([^/]+)\/runs$/.exec(
          url.pathname,
        );

        if (req.method === "GET" && projectMatch) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: projectMatch[1], name: "GLU-194 fake project" }));
          return;
        }
        if (req.method === "GET" && targetMatch) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: targetMatch[2] }));
          return;
        }
        if (req.method === "POST" && runsMatch) {
          let raw = "";
          req.on("data", (chunk) => {
            raw += chunk;
          });
          req.on("end", () => {
            const body = JSON.parse(raw) as Record<string, unknown>;
            ingestedBodies.push(body);
            res.writeHead(201, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                id: "run_glu194_fake",
                projectId: runsMatch[1],
                targetId: runsMatch[2],
                kind: "test",
              }),
            );
          });
          return;
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
      },
    );
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolvePromise({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => server.close(),
        ingestedBodies,
      });
    });
  });
}

test(
  "glubean run: an all-broken run with --upload is recorded as a FAILED run with discoveryFailures, not passed/empty (GLU-194)",
  async () => {
    const { baseUrl, close, ingestedBodies } = await startFakePlatform();
    let dir: string;
    try {
      dir = await prepareAllBroken("upload");

      const { code, stdout, stderr } = await runCli(
        [
          "run",
          "contracts/",
          "--upload",
          "--api-url",
          baseUrl,
          "--token",
          "glb_fake_token_for_glu194_test",
          "--project",
          "proj_glu194",
          "--upload-target",
          "tgt_glu194",
        ],
        { cwd: dir },
      );
      const out = stdout + stderr;

      // The run genuinely failed (import failures) — must stay non-zero,
      // and the upload path itself must not report an upload-side failure.
      expect(code).not.toBe(0);
      expect(out).not.toContain("Upload failed");

      // THE GAP this test guards: before GLU-194, `--upload` was never
      // reached at all for an all-broken run — the early-exit `process.exit`
      // fired long before this code path. Now it must have posted exactly
      // one run ingest.
      expect(ingestedBodies).toHaveLength(1);
      const body = ingestedBodies[0];

      // Status must be "failed" — never "passed" (there were zero passing
      // tests to hide behind) and never silently omitted/defaulted.
      expect(body.status).toBe("failed");
      expect(body.summary).toMatchObject({ total: 0, passed: 0, failed: 0 });

      const result = body.result as { discoveryFailures?: Array<{ filePath: string }>; tests?: unknown[] };
      expect(result.discoveryFailures).toHaveLength(2);
      const failedPaths = (result.discoveryFailures ?? [])
        .map((d) => d.filePath)
        .sort();
      expect(failedPaths).toEqual([
        "contracts/broken-2.contract.ts",
        "contracts/broken.contract.ts",
      ]);
      expect(result.tests).toEqual([]);
      // No per-test rows to report — the analytics substrate must not
      // fabricate any.
      expect(body.testResults).toBeUndefined();
    } finally {
      close();
    }
  },
  30_000,
);
