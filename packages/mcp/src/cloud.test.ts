/**
 * Tests for the /v1 Cloud client used by the MCP open* tools (GLU-77).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_API_URL,
  MISSING_AUTH_MESSAGES,
  buildRunIngestBody,
  cloudFetchJson,
  envLabelFromEnvFile,
  loadUploadRedaction,
  resolveCloudAuth,
  resolveDefaultTargetId,
  runIngestUrl,
  runTestEventsUrl,
  runTestResultsUrl,
  runUrl,
  type SnapshotForUpload,
} from "./cloud.js";
import { MCP_PACKAGE_VERSION } from "./version.js";

const GLUBEAN_ENV_KEYS = [
  "GLUBEAN_TOKEN",
  "GLUBEAN_PROJECT_ID",
  "GLUBEAN_TARGET_ID",
  "GLUBEAN_API_URL",
  "GLUBEAN_PLATFORM_API_URL",
] as const;

let savedEnv: Record<string, string | undefined>;
let savedHome: string | undefined;

beforeEach(() => {
  savedEnv = {};
  for (const key of GLUBEAN_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  savedHome = process.env.HOME;
});

afterEach(() => {
  for (const key of GLUBEAN_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  vi.unstubAllGlobals();
});

describe("resolveCloudAuth", () => {
  it("prefers explicit args over everything", async () => {
    process.env.GLUBEAN_TOKEN = "env-token";
    process.env.GLUBEAN_PROJECT_ID = "env-proj";
    const auth = await resolveCloudAuth(
      { token: "arg-token", projectId: "arg-proj", targetId: "arg-tgt", apiUrl: "https://x.test/" },
      { envFileVars: { GLUBEAN_TOKEN: "file-token" } },
    );
    expect(auth).toEqual({
      apiUrl: "https://x.test",
      token: "arg-token",
      projectId: "arg-proj",
      targetId: "arg-tgt",
    });
  });

  it("prefers process env over .env file vars", async () => {
    process.env.GLUBEAN_TOKEN = "env-token";
    const auth = await resolveCloudAuth(
      {},
      { envFileVars: { GLUBEAN_TOKEN: "file-token", GLUBEAN_PROJECT_ID: "file-proj" } },
    );
    expect(auth.token).toBe("env-token");
    expect(auth.projectId).toBe("file-proj");
  });

  it("treats an empty-string env var as absent (|| not ??)", async () => {
    process.env.GLUBEAN_TOKEN = "";
    const auth = await resolveCloudAuth(
      {},
      { envFileVars: { GLUBEAN_TOKEN: "file-token" } },
    );
    expect(auth.token).toBe("file-token");
  });

  it("falls back to ~/.glubean/credentials.json for token/projectId/apiUrl", async () => {
    const home = await mkdtemp(join(tmpdir(), "glubean-mcp-home-"));
    try {
      await mkdir(join(home, ".glubean"), { recursive: true });
      await writeFile(
        join(home, ".glubean", "credentials.json"),
        JSON.stringify({
          token: "creds-token",
          projectId: "creds-proj",
          apiUrl: "https://creds.test",
        }),
        "utf-8",
      );
      process.env.HOME = home;
      const auth = await resolveCloudAuth({});
      expect(auth.token).toBe("creds-token");
      expect(auth.projectId).toBe("creds-proj");
      expect(auth.apiUrl).toBe("https://creds.test");
      // The credentials file carries no target — stays undefined.
      expect(auth.targetId).toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("defaults apiUrl to the platform API when nothing is configured", async () => {
    process.env.HOME = await mkdtemp(join(tmpdir(), "glubean-mcp-nohome-"));
    const auth = await resolveCloudAuth({});
    expect(auth.apiUrl).toBe(DEFAULT_API_URL);
    expect(auth.token).toBeUndefined();
    expect(auth.projectId).toBeUndefined();
  });

  // GLU-139: a project (e.g. the dogfood repo) can legitimately set
  // GLUBEAN_API_URL for an unrelated Dashboard API while also setting
  // GLUBEAN_PLATFORM_API_URL for the Platform/ingest API these tools need.
  // GLUBEAN_PLATFORM_API_URL must win so open* tools don't 404 against the
  // Dashboard host when relying on project env resolution (no explicit
  // apiUrl argument).
  it("prefers GLUBEAN_PLATFORM_API_URL over GLUBEAN_API_URL for apiUrl", async () => {
    process.env.HOME = await mkdtemp(join(tmpdir(), "glubean-mcp-nohome-"));
    process.env.GLUBEAN_API_URL = "https://api.staging.glubean.com";
    process.env.GLUBEAN_PLATFORM_API_URL = "https://platform.staging.glubean.com";
    const auth = await resolveCloudAuth({});
    expect(auth.apiUrl).toBe("https://platform.staging.glubean.com");
  });

  it("falls back to GLUBEAN_API_URL when GLUBEAN_PLATFORM_API_URL is unset (legacy projects)", async () => {
    process.env.HOME = await mkdtemp(join(tmpdir(), "glubean-mcp-nohome-"));
    process.env.GLUBEAN_API_URL = "https://platform.glubean.com";
    const auth = await resolveCloudAuth({});
    expect(auth.apiUrl).toBe("https://platform.glubean.com");
  });

  it("an explicit apiUrl argument still overrides both platform and legacy env vars", async () => {
    process.env.HOME = await mkdtemp(join(tmpdir(), "glubean-mcp-nohome-"));
    process.env.GLUBEAN_API_URL = "https://api.staging.glubean.com";
    process.env.GLUBEAN_PLATFORM_API_URL = "https://platform.staging.glubean.com";
    const auth = await resolveCloudAuth({ apiUrl: "https://explicit.test/" });
    expect(auth.apiUrl).toBe("https://explicit.test");
  });

  it("reads GLUBEAN_PLATFORM_API_URL from .env file vars, same precedence as process env", async () => {
    process.env.HOME = await mkdtemp(join(tmpdir(), "glubean-mcp-nohome-"));
    process.env.GLUBEAN_API_URL = "https://api.staging.glubean.com";
    const auth = await resolveCloudAuth(
      {},
      { envFileVars: { GLUBEAN_PLATFORM_API_URL: "https://platform.staging.glubean.com" } },
    );
    expect(auth.apiUrl).toBe("https://platform.staging.glubean.com");
  });
});

describe("resolveDefaultTargetId", () => {
  it("derives the default target for a default project without a network call", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const id = await resolveDefaultTargetId("https://x.test", "proj_default_org1", "tok");
    expect(id).toBe("tgt_default_org1");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("picks the 'default' slug from the target list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify([
            { id: "tgt_a", slug: "other" },
            { id: "tgt_b", slug: "default" },
          ]),
          { status: 200 },
        ),
      ),
    );
    const id = await resolveDefaultTargetId("https://x.test", "proj_x", "tok");
    expect(id).toBe("tgt_b");
  });

  it("auto-picks a single target; ambiguous lists resolve to null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify([{ id: "tgt_only", slug: "x" }]), { status: 200 }),
      ),
    );
    expect(await resolveDefaultTargetId("https://x.test", "proj_x", "tok")).toBe("tgt_only");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify([
            { id: "tgt_a", slug: "x" },
            { id: "tgt_b", slug: "y" },
          ]),
          { status: 200 },
        ),
      ),
    );
    expect(await resolveDefaultTargetId("https://x.test", "proj_x", "tok")).toBeNull();
  });

  it("returns null on HTTP failure (caller asks for an explicit target)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 403 })));
    expect(await resolveDefaultTargetId("https://x.test", "proj_x", "tok")).toBeNull();
  });
});

describe("/v1 URL builders", () => {
  it("builds target-scoped run URLs with encoded path params", () => {
    expect(runIngestUrl("https://x.test/", "p 1", "t/2")).toBe(
      "https://x.test/v1/projects/p%201/targets/t%2F2/runs",
    );
    expect(runUrl("https://x.test", "p", "t", "r 1")).toBe(
      "https://x.test/v1/projects/p/targets/t/runs/r%201",
    );
    expect(runTestResultsUrl("https://x.test", "p", "t", "r")).toBe(
      "https://x.test/v1/projects/p/targets/t/runs/r/test-results",
    );
    expect(runTestEventsUrl("https://x.test", "p", "t", "r", "suite.case#1")).toBe(
      "https://x.test/v1/projects/p/targets/t/runs/r/tests/suite.case%231/events",
    );
  });
});

describe("cloudFetchJson", () => {
  it("sends the bearer token and parses JSON", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ id: "run_1" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchSpy);
    const json = await cloudFetchJson("https://x.test/v1/anything", {
      method: "POST",
      token: "tok-123",
    });
    expect(json).toEqual({ id: "run_1" });
    const [, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-123");
  });

  it("maps auth/lookup failures to human-actionable messages", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    await expect(cloudFetchJson("https://x.test/u", { token: "t" })).rejects.toThrow(
      /Unauthorized \(401\).*GLUBEAN_TOKEN.*glubean login/s,
    );

    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    await expect(cloudFetchJson("https://x.test/u", { token: "t" })).rejects.toThrow(
      /Not found \(404\).*projectId \/ targetId \/ runId/s,
    );

    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    await expect(cloudFetchJson("https://x.test/u", { token: "t" })).rejects.toThrow(
      /HTTP 500: boom/,
    );
  });

  it("scrubs bearer-token-shaped strings from error bodies", async () => {
    const leaked = "proxy echo: Authorization: Bearer glb_SuperSecretValue123456";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(leaked, { status: 502 })));
    const err = await cloudFetchJson("https://x.test/u", { token: "t" }).catch((e) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain("glb_SuperSecretValue123456");
    expect((err as Error).message).toContain("[redacted]");
  });

  it("maps an aborted request to a friendly timeout message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation was aborted.", "AbortError");
      }),
    );
    await expect(
      cloudFetchJson("https://x.test/u", { token: "t", timeoutMs: 123 }),
    ).rejects.toThrow(/timed out after 123ms/);
  });
});

describe("envLabelFromEnvFile", () => {
  it("mirrors the CLI's env label derivation", () => {
    expect(envLabelFromEnvFile(undefined)).toBe("default");
    expect(envLabelFromEnvFile("/proj/.env")).toBe("default");
    expect(envLabelFromEnvFile("/proj/.env.staging")).toBe("staging");
    expect(envLabelFromEnvFile("/proj/custom.env")).toBe("custom");
  });
});

describe("loadUploadRedaction", () => {
  it("merges glubean.yaml defaults.redaction on the built-in baseline", async () => {
    const root = await mkdtemp(join(tmpdir(), "glubean-mcp-redact-"));
    try {
      await writeFile(
        join(root, "glubean.yaml"),
        [
          "defaults:",
          "  redaction:",
          "    sensitiveKeys: [xInternalId]",
          "    customPatterns:",
          "      - name: acme-key",
          "        regex: 'ACME-[0-9]{8}'",
          "    replacementFormat: labeled",
        ].join("\n"),
        "utf-8",
      );
      const r = await loadUploadRedaction(root);
      expect(r.globalRules.sensitiveKeys).toContain("xInternalId");
      expect(r.globalRules.customPatterns).toEqual([
        { name: "acme-key", regex: "ACME-[0-9]{8}" },
      ]);
      expect(r.replacementFormat).toBe("labeled");
      // Baseline patterns preserved.
      expect(r.globalRules.patterns).toContain("bearer");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to the baseline without glubean.yaml", async () => {
    const root = await mkdtemp(join(tmpdir(), "glubean-mcp-noyaml-"));
    try {
      const r = await loadUploadRedaction(root);
      expect(r.replacementFormat).toBe("partial");
      expect(r.globalRules.customPatterns).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function makeSnapshot(overrides?: Partial<SnapshotForUpload>): SnapshotForUpload {
  return {
    createdAt: "2026-07-02T10:00:00.000Z",
    fileUrl: "file:///proj/tests/api.test.ts",
    projectRoot: "/proj",
    summary: { total: 3, passed: 1, failed: 1, skipped: 1 },
    results: [
      {
        exportName: "ok",
        id: "t.ok",
        name: "passes",
        success: true,
        durationMs: 100,
        assertions: [{ passed: true, message: "status is 200" }],
        logs: [{ message: "hello", data: { password: "supersecret123" } }],
      },
      {
        exportName: "bad",
        id: "t.bad",
        name: "fails",
        success: false,
        durationMs: 50,
        assertions: [
          { passed: false, message: "status", actual: 500, expected: 200 },
        ],
        logs: [],
        error: { message: "boom" },
      },
      {
        exportName: "skip",
        id: "t.skip",
        name: "skips",
        success: true,
        skipped: true,
        durationMs: 5,
        assertions: [],
        logs: [],
      },
    ],
    ...overrides,
  };
}

describe("buildRunIngestBody", () => {
  it("builds a glubean.test.v1 RunIngest envelope from a local snapshot", () => {
    const body = buildRunIngestBody(makeSnapshot(), { environment: "staging" });
    expect(body.kind).toBe("test");
    expect(body.schemaVersion).toBe("glubean.test.v1");
    expect(body.status).toBe("failed"); // failed > 0
    expect(body.startedAt).toBe("2026-07-02T10:00:00.000Z");
    expect(body.durationMs).toBe(155);
    expect(body.completedAt).toBe(
      new Date(Date.parse("2026-07-02T10:00:00.000Z") + 155).toISOString(),
    );
    expect(body.summary).toEqual({
      total: 3,
      passed: 1,
      failed: 1,
      skipped: 1,
      durationMs: 155,
    });
    expect(body.trigger).toBe("mcp");
    expect(body.runnerVersion).toBe(MCP_PACKAGE_VERSION);
    expect(body.environment).toBe("staging");
    expect(typeof body.clientRunId).toBe("string");
    expect((body.clientRunId as string).length).toBeGreaterThan(0);
  });

  it("reports passed when nothing failed", () => {
    const snapshot = makeSnapshot({
      summary: { total: 1, passed: 1, failed: 0, skipped: 0 },
      results: [makeSnapshot().results[0]!],
    });
    expect(buildRunIngestBody(snapshot).status).toBe("passed");
  });

  it("maps per-test rows to the test_result substrate (skipped excluded from pass/fail)", () => {
    const body = buildRunIngestBody(makeSnapshot());
    expect(body.testResults).toEqual([
      { testId: "t.ok", name: "passes", status: "passed", durationMs: 100 },
      { testId: "t.bad", name: "fails", status: "failed", durationMs: 50 },
      { testId: "t.skip", name: "skips", status: "skipped", durationMs: 5 },
    ]);
  });

  it("shapes result.tests[].events so Cloud's per-test drill-down can read them", () => {
    const body = buildRunIngestBody(makeSnapshot());
    const result = body.result as {
      tests: Array<{ testId: string; events: Array<{ type: string }> }>;
    };
    expect(result.tests.map((t) => t.testId)).toEqual(["t.ok", "t.bad", "t.skip"]);
    const bad = result.tests[1]!;
    expect(bad.events.map((e) => e.type)).toEqual(["assertion", "error", "status"]);
    const skip = result.tests[2]!;
    expect(skip.events.at(-1)).toEqual({ type: "status", status: "skipped" });
  });

  it("redacts secrets in the result blob before upload", () => {
    const body = buildRunIngestBody(makeSnapshot());
    const serialized = JSON.stringify(body.result);
    expect(serialized).not.toContain("supersecret123");
  });

  it("applies project custom redaction rules when provided", () => {
    const snapshot = makeSnapshot();
    snapshot.results[0]!.logs.push({
      message: "custom",
      data: { note: "key is ACME-12345678" },
    });
    const body = buildRunIngestBody(snapshot, {
      redaction: {
        globalRules: {
          sensitiveKeys: [],
          patterns: [],
          customPatterns: [{ name: "acme-key", regex: "ACME-[0-9]{8}" }],
        },
        replacementFormat: "labeled",
      },
    });
    expect(JSON.stringify(body.result)).not.toContain("ACME-12345678");
  });

  it("uses wall-clock timing and the snapshot's stable clientRunId when present", () => {
    const snapshot = makeSnapshot({
      startedAt: "2026-07-02T09:59:58.000Z", // run ENDED at createdAt 10:00:00
      clientRunId: "stable-id-1",
    });
    const body = buildRunIngestBody(snapshot);
    expect(body.startedAt).toBe("2026-07-02T09:59:58.000Z");
    expect(body.completedAt).toBe("2026-07-02T10:00:00.000Z");
    expect(body.durationMs).toBe(2000);
    expect(body.clientRunId).toBe("stable-id-1");
    // Re-building for a retry keeps the id → Cloud replaces, not duplicates.
    expect(buildRunIngestBody(snapshot).clientRunId).toBe("stable-id-1");
  });

  it("never includes traces in the uploaded result (local trace view keeps auth headers)", () => {
    const body = buildRunIngestBody(makeSnapshot());
    const result = body.result as { tests: Array<Record<string, unknown>> };
    for (const t of result.tests) {
      expect(t).not.toHaveProperty("traces");
      const events = t.events as Array<{ type: string }>;
      expect(events.every((e) => e.type !== "trace")).toBe(true);
    }
  });
});

describe("missing-auth messages", () => {
  it("tells the user exactly what to configure", () => {
    expect(MISSING_AUTH_MESSAGES.token).toMatch(/GLUBEAN_TOKEN/);
    expect(MISSING_AUTH_MESSAGES.token).toMatch(/glubean login/);
    expect(MISSING_AUTH_MESSAGES.projectId).toMatch(/GLUBEAN_PROJECT_ID/);
    expect(MISSING_AUTH_MESSAGES.targetId).toMatch(/GLUBEAN_TARGET_ID/);
  });
});
