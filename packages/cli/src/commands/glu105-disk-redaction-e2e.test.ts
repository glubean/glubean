/**
 * GLU-105 regression — CLI must not write plaintext secrets to local disk.
 *
 * `glubean run` used to redact the HTTP trace event stream ONLY inside the
 * clone built for `--upload`. Every local-disk sink (`.glubean/last-run.result.json`,
 * `--result-json`, `.glubean/traces.json`, `--log-file`, `--verbose` console
 * output, `--emit-full-trace` trace files) read the RAW, unredacted event —
 * so `Authorization` headers / cookies / query tokens / request-body
 * passwords landed on disk in cleartext regardless of whether `--upload`
 * was ever passed.
 *
 * This test spawns the real CLI (via `runCli`, a genuine subprocess — no
 * fabricated result data) against a real local HTTP server that echoes a
 * request carrying secrets in four channels (Authorization header, query
 * string, request-body field, response Set-Cookie header + response body),
 * with every disk-writing flag enabled and `--upload` OMITTED. It then reads
 * every artifact the CLI wrote and asserts none of the five secret literals
 * appear anywhere in cleartext.
 *
 * GLU-209 follow-up: the `--reporter junit` XML sink was not covered by the
 * assertions above. It's built from `collectedRuns` (same already-redacted
 * `event` object pushed into `testEvents` inside the `file:event` handler —
 * see the redaction comment at that call site), so it should already be
 * safe, but this had no direct regression coverage. A second test below
 * exercises `--reporter junit` end-to-end and asserts the XML file is clean.
 */
import { createServer, type Server } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";
import { runCli } from "../test-helpers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(HERE, "..", "..", ".tmp-glu105-disk-redaction-e2e");
let seq = 0;

// Five distinct secret literals, one per redaction channel exercised by this
// test. Long + unique enough that (a) genericPartialMask's 3-head/3-tail
// partial reveal can never expose the FULL literal, and (b) an accidental
// substring collision with unrelated CLI/runner output is implausible.
const HEADER_SECRET = "GLU105-HEADER-SECRET-4f8a2c9e1b";
const QUERY_SECRET = "GLU105-QUERY-SECRET-7d3e6a0f21";
const BODY_PASSWORD_SECRET = "GLU105-BODY-PASSWORD-SECRET-9c1b4e7a3d";
// Set-Cookie value redaction is pattern-based (the `http.response.headers`
// scope's `sensitiveKeys: ["set-cookie"]` matches the raw HEADER name, not
// the parsed cookie's own key — a separate, pre-existing gap in
// @glubean/redaction unrelated to GLU-105's disk-vs-upload routing bug), so
// use a hex-shaped literal that trips the global `hexKeys` VALUE pattern
// instead of relying on key-name matching.
const COOKIE_SECRET = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
const RESPONSE_BEARER_SECRET = "GLU105-RESPONSE-BEARER-SECRET-5e0b8a3f7d";

// Non-event payload secrets (codex R3 P1): these ride NON-event fields that
// also land on the local-disk result JSON, not the redacted event stream.
//   • CMD_TOKEN_SECRET flows through `--token` → captured verbatim in
//     `context.command` (raw argv). The command field is DROPPED from the
//     result payload entirely, so the token must vanish from disk.
//   • META_TOKEN_SECRET is a github-token-shaped `--meta` value → lands in
//     `customMetadata`; the value-pattern redaction must mask it on disk.
const CMD_TOKEN_SECRET = "glb_GLU105cmdtokensecret_do_not_persist_zzz";
const META_TOKEN_SECRET = "ghp_GLU105metaSecretAAAAAAAAAAAAAAAAAAAAAAAA";

function pkgJson(name: string): string {
  return JSON.stringify(
    {
      name,
      type: "module",
      version: "0.0.0",
      dependencies: { "@glubean/sdk": "workspace:*", "@glubean/runner": "workspace:*" },
    },
    null,
    2,
  );
}

/** Real local HTTP server — the secrets genuinely travel over the wire. */
function startSecretServer(): Promise<{ baseUrl: string; close: () => void }> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        res.writeHead(200, {
          "content-type": "application/json",
          "set-cookie": `session=${COOKIE_SECRET}; Path=/; HttpOnly`,
        });
        // Response body carries a Bearer-shaped literal so the (key-less,
        // pattern-only) http.response.body scope also has something to catch.
        res.end(
          JSON.stringify({
            ok: true,
            echoedBodyLength: raw.length,
            note: `Bearer ${RESPONSE_BEARER_SECRET}`,
          }),
        );
      });
    });
    // Reject on a bind failure so a restricted CI/sandbox runner fails fast
    // with the real error instead of hanging until the Vitest timeout.
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ baseUrl: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*m/g, "");
}

/** Pulls the path the CLI printed after a `<label>: ` marker in stdout. */
function extractPrintedPath(out: string, label: string): string | undefined {
  const clean = stripAnsi(out);
  const re = new RegExp(`${label}:\\s*(\\S+)`);
  return re.exec(clean)?.[1];
}

async function prepare(name: string, baseUrl: string): Promise<string> {
  seq += 1;
  const dir = join(FIXTURE_ROOT, `${name}-${seq}`);
  await mkdir(join(dir, "tests"), { recursive: true });
  await writeFile(join(dir, "package.json"), pkgJson(`glu105-e2e-${seq}`), "utf-8");
  await writeFile(
    join(dir, "tests", "secret.test.ts"),
    `
import { test } from "@glubean/sdk";

export const secretCall = test("secretCall", async (ctx) => {
  const res = await ctx.http.post(
    "${baseUrl}/secret?token=${QUERY_SECRET}",
    {
      headers: { Authorization: "Bearer ${HEADER_SECRET}" },
      json: { password: "${BODY_PASSWORD_SECRET}" },
    },
  );
  const data = await res.json();
  ctx.assert(data.ok === true, "response should be ok");
});
`,
    "utf-8",
  );
  return dir;
}

// GLU-209: same secret-carrying HTTP call as `prepare`, plus a SECOND test
// that deliberately fails an assertion — so the JUnit `<failure>` branch of
// `toJunitXml` (which is a narrower sink than result.json: it only ever
// serializes `classname`/`name`/`time` plus `status.error` /
// assertion-message TEXT, never the raw event/requestBody objects) gets
// real exercise, not just the always-`<testcase .../>` passing branch.
async function prepareJunit(name: string, baseUrl: string): Promise<string> {
  seq += 1;
  const dir = join(FIXTURE_ROOT, `${name}-${seq}`);
  await mkdir(join(dir, "tests"), { recursive: true });
  await writeFile(join(dir, "package.json"), pkgJson(`glu105-e2e-${seq}`), "utf-8");
  await writeFile(
    join(dir, "tests", "secret.test.ts"),
    `
import { test } from "@glubean/sdk";

export const secretCall = test("secretCall", async (ctx) => {
  const res = await ctx.http.post(
    "${baseUrl}/secret?token=${QUERY_SECRET}",
    {
      headers: { Authorization: "Bearer ${HEADER_SECRET}" },
      json: { password: "${BODY_PASSWORD_SECRET}" },
    },
  );
  const data = await res.json();
  ctx.assert(data.ok === true, "response should be ok");
});

export const secretCallFailing = test("secretCallFailing", async (ctx) => {
  const res = await ctx.http.post(
    "${baseUrl}/secret?token=${QUERY_SECRET}",
    {
      headers: { Authorization: "Bearer ${HEADER_SECRET}" },
      json: { password: "${BODY_PASSWORD_SECRET}" },
    },
  );
  const data = await res.json();
  // Deliberately fail — asserts a false condition so this test lands in the
  // JUnit <failure> branch. The message itself is intentionally secret-free
  // (embedding a secret in a user-authored free-text message is a separate,
  // pre-existing key/pattern-matching limitation, not what GLU-209 is about).
  ctx.assert(data.ok === false, "intentional failure for JUnit coverage");
});
`,
    "utf-8",
  );
  return dir;
}

const ALL_SECRETS = [
  HEADER_SECRET,
  QUERY_SECRET,
  BODY_PASSWORD_SECRET,
  COOKIE_SECRET,
  RESPONSE_BEARER_SECRET,
];

function assertNoSecretsIn(label: string, content: string): void {
  for (const secret of ALL_SECRETS) {
    expect(content, `${label} must not contain plaintext secret ${JSON.stringify(secret)}`)
      .not.toContain(secret);
  }
}

afterAll(async () => {
  await rm(FIXTURE_ROOT, { recursive: true, force: true });
});

test(
  "a real `glubean run` (no --upload) never writes plaintext secrets to any local-disk artifact",
  async () => {
    const { baseUrl, close } = await startSecretServer();
    let dir: string;
    try {
      dir = await prepare("no-upload", baseUrl);

      const { stdout, stderr } = await runCli(
        [
          "run",
          "tests/secret.test.ts",
          "--no-session",
          "--verbose",
          "--log-file",
          "--emit-full-trace",
          "--result-json",
          "result.json",
          // Non-event channels (codex R3 P1): --token rides context.command
          // (raw argv), --meta rides customMetadata. Both hit the disk result
          // JSON, which is NOT part of the redacted event stream.
          "--token",
          CMD_TOKEN_SECRET,
          "--meta",
          `authToken=${META_TOKEN_SECRET}`,
        ],
        { cwd: dir },
      );
      const out = stdout + stderr;

      // Sanity: the run actually happened and passed — otherwise this test
      // would trivially pass by never exercising the redaction path at all.
      expect(out).toContain("secretCall");
      expect(out).not.toMatch(/FAILED/);

      // ── 1. `.glubean/last-run.result.json` (unconditional, every run) ──
      const lastRun = await readFile(
        join(dir, ".glubean", "last-run.result.json"),
        "utf-8",
      );
      assertNoSecretsIn(".glubean/last-run.result.json", lastRun);
      // Sanity: the trace event genuinely made it into the payload (proves
      // we're not just testing an empty/skipped run).
      expect(lastRun).toContain("secretCall");

      // ── 2. `--result-json result.json` ──
      const resultJsonPath = extractPrintedPath(out, "Result written to");
      expect(resultJsonPath, "CLI must print the --result-json output path").toBeTruthy();
      const resultJson = await readFile(resultJsonPath!, "utf-8");
      assertNoSecretsIn("--result-json output", resultJson);

      // ── 2b. Non-event payload fields (codex R3 P1) — context.command /
      //        customMetadata land on the SAME result-JSON sinks but aren't
      //        part of the redacted event stream. ──
      for (const [label, content] of [
        [".glubean/last-run.result.json", lastRun],
        ["--result-json output", resultJson],
      ] as const) {
        expect(content, `${label} must not contain the raw --token argv secret`)
          .not.toContain(CMD_TOKEN_SECRET);
        expect(content, `${label} must not contain the raw --meta value secret`)
          .not.toContain(META_TOKEN_SECRET);
      }
      const parsedLastRun = JSON.parse(lastRun) as {
        context?: { command?: unknown };
        customMetadata?: Record<string, unknown>;
      };
      // `context.command` (raw argv, carries the token) is dropped entirely.
      expect(parsedLastRun.context?.command).toBeUndefined();
      // customMetadata IS persisted (redacted), proving --meta was captured
      // and the assertion above isn't vacuous.
      expect(parsedLastRun.customMetadata).toBeDefined();
      expect(JSON.stringify(parsedLastRun.customMetadata)).not.toContain(META_TOKEN_SECRET);

      // ── 3. `.glubean/traces.json` (URL query-string channel) ──
      const tracesJson = await readFile(join(dir, ".glubean", "traces.json"), "utf-8");
      assertNoSecretsIn(".glubean/traces.json", tracesJson);
      expect(tracesJson).toContain("secretCall");

      // ── 4. `--log-file` text output ──
      const logPath = extractPrintedPath(out, "Log written to");
      expect(logPath, "CLI must print the --log-file output path").toBeTruthy();
      const logContent = await readFile(logPath!, "utf-8");
      assertNoSecretsIn("--log-file output", logContent);

      // ── 5. `--emit-full-trace` .trace.jsonc file ──
      const tracePath = extractPrintedPath(out, "Trace");
      expect(tracePath, "CLI must print the --emit-full-trace output path").toBeTruthy();
      const traceContent = await readFile(tracePath!, "utf-8");
      assertNoSecretsIn("--emit-full-trace .trace.jsonc file", traceContent);
      // Sanity: the trace file is the real HTTP exchange, not an empty stub.
      expect(traceContent).toContain("/secret");

      // ── 6. `--verbose` console output (stdout/stderr themselves) ──
      assertNoSecretsIn("--verbose console output", out);
    } finally {
      close();
    }
  },
  60_000,
);

test(
  "a real `glubean run --reporter junit` (no --upload) never writes plaintext secrets into the JUnit XML sink",
  async () => {
    const { baseUrl, close } = await startSecretServer();
    let dir: string;
    try {
      dir = await prepareJunit("junit", baseUrl);

      const { stdout, stderr } = await runCli(
        [
          "run",
          "tests/secret.test.ts",
          "--no-session",
          "--reporter",
          "junit:glubean-run.junit.xml",
        ],
        { cwd: dir },
      );
      const out = stdout + stderr;

      // Sanity: both tests genuinely ran — one passes, one fails — so this
      // exercises both the plain `<testcase .../>` branch AND the
      // `<failure>` branch of toJunitXml, not a vacuous all-pass run.
      expect(out).toContain("secretCall");
      expect(out).toContain("secretCallFailing");

      const junitPath = extractPrintedPath(out, "JUnit XML written to");
      expect(junitPath, "CLI must print the --reporter junit output path").toBeTruthy();
      const junitXml = await readFile(junitPath!, "utf-8");

      assertNoSecretsIn("--reporter junit XML output", junitXml);
      // Sanity: the failing test's <failure> block is actually in there,
      // proving the failure branch (not just the passing branch) ran.
      expect(junitXml).toContain("secretCallFailing");
      expect(junitXml).toContain("<failure");
    } finally {
      close();
    }
  },
  60_000,
);
