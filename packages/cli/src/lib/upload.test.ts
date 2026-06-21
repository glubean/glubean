import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { uploadToCloud, type UploadRunInput } from "./upload.js";

const input: UploadRunInput = {
  kind: "test",
  schemaVersion: "glubean.test.v1",
  status: "passed",
  startedAt: "2026-05-29T00:00:00.000Z",
  durationMs: 12,
  summary: { total: 1, passed: 1, failed: 0 },
  result: {
    runAt: "2026-05-29T00:00:00.000Z",
    tests: [{ testId: "smoke", testName: "smoke", success: true, durationMs: 12, events: [] }],
  },
  testResults: [
    { testId: "smoke", name: "smoke", status: "passed", durationMs: 12, eventCount: 0 },
  ],
  metrics: [
    { name: "http_duration_ms", value: 8, unit: "ms", tags: { method: "GET", path: "/" }, testId: "smoke" },
  ],
};

const baseOptions = {
  apiUrl: "https://api.glubean.test",
  token: "gb_test",
  projectId: "proj_123",
  targetId: "tgt_123",
};

function runResponse(id = "run_123") {
  return new Response(
    JSON.stringify({ id, projectId: "proj_123", targetId: "tgt_123", kind: "test" }),
    { status: 201, headers: { "Content-Type": "application/json" } },
  );
}

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "glubean-upload-test-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(rootDir, { recursive: true, force: true }).catch(() => {});
});

test("uploadToCloud posts a RunIngest to the target-scoped endpoint with a constructed deep link", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(runResponse());
  vi.stubGlobal("fetch", fetchMock);

  const receipt = await uploadToCloud(input, { ...baseOptions, rootDir });

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe("https://api.glubean.test/v1/projects/proj_123/targets/tgt_123/runs");
  expect(init.method).toBe("POST");

  const body = JSON.parse(init.body as string);
  expect(body).toMatchObject({
    kind: "test",
    schemaVersion: "glubean.test.v1",
    status: "passed",
    startedAt: "2026-05-29T00:00:00.000Z",
    durationMs: 12,
    summary: { total: 1, passed: 1, failed: 0 },
    runnerVersion: expect.any(String),
    trigger: expect.any(String),
  });
  // result blob + analytics substrate ride along.
  expect(body.result.tests).toHaveLength(1);
  expect(body.testResults).toHaveLength(1);
  expect(body.metrics[0].name).toBe("http_duration_ms");

  expect(receipt).toMatchObject({
    schemaVersion: "glubean.upload-receipt.v1",
    apiUrl: "https://api.glubean.test",
    projectId: "proj_123",
    targetId: "tgt_123",
    runId: "run_123",
    // Canonical API resource URL (real + addressable + full project/target/run
    // context). A dashboard deep link lands with M2.
    url: "https://api.glubean.test/v1/projects/proj_123/targets/tgt_123/runs/run_123",
    resultUpload: {
      status: "uploaded",
      runId: "run_123",
      url: "https://api.glubean.test/v1/projects/proj_123/targets/tgt_123/runs/run_123",
      statusCode: 201,
    },
    artifactUpload: { status: "skipped", attempted: false, count: 0 },
  });
  expect(receipt.uploadedAt).toEqual(expect.any(String));
});

test("uploadToCloud sends default environment when no env file is provided", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(runResponse());
  vi.stubGlobal("fetch", fetchMock);

  await uploadToCloud(input, { ...baseOptions, rootDir });

  const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
  expect(body.environment).toBe("default");
});

test("uploadToCloud derives environment from dot-env file name", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(runResponse());
  vi.stubGlobal("fetch", fetchMock);

  await uploadToCloud(input, { ...baseOptions, envFile: ".env.staging", rootDir });

  const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
  expect(body.environment).toBe("staging");
});

test("uploadToCloud lets GLUBEAN_ENV override env file label", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(runResponse());
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("GLUBEAN_ENV", "preview-us");

  await uploadToCloud(input, { ...baseOptions, envFile: ".env.staging", rootDir });

  const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
  expect(body.environment).toBe("preview-us");
});

test("uploadToCloud returns a failed receipt when ingest is rejected", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(
    new Response("unauthorized", { status: 401 }),
  );
  vi.stubGlobal("fetch", fetchMock);

  const receipt = await uploadToCloud(input, { ...baseOptions, token: "gb_bad", rootDir });

  expect(receipt).toMatchObject({
    schemaVersion: "glubean.upload-receipt.v1",
    apiUrl: "https://api.glubean.test",
    projectId: "proj_123",
    targetId: "tgt_123",
    resultUpload: {
      status: "failed",
      statusCode: 401,
      error: "unauthorized",
    },
    artifactUpload: { status: "skipped", attempted: false, count: 0 },
  });
});

test("uploadToCloud fails cleanly when the response omits the run id", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(
    new Response(JSON.stringify({ projectId: "proj_123" }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);

  const receipt = await uploadToCloud(input, { ...baseOptions, rootDir });

  expect(receipt.resultUpload.status).toBe("failed");
  expect(receipt.runId).toBeUndefined();
});

test("uploadToCloud uploads load runs (kind=load, LoadArtifact as result)", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(runResponse("run_load_1"));
  vi.stubGlobal("fetch", fetchMock);

  const loadInput: UploadRunInput = {
    kind: "load",
    schemaVersion: "glubean.load.v1",
    status: "failed",
    startedAt: "2026-05-29T00:00:00.000Z",
    durationMs: 60000,
    summary: { throughputPerSec: 120.5, errorRate: 0.02 },
    result: { schemaVersion: "glubean.load.v1", runnerId: "checkout" },
  };

  const receipt = await uploadToCloud(loadInput, { ...baseOptions, rootDir });

  const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
  expect(body.kind).toBe("load");
  expect(body.schemaVersion).toBe("glubean.load.v1");
  expect(body.status).toBe("failed");
  expect(body.summary).toMatchObject({ throughputPerSec: 120.5, errorRate: 0.02 });
  expect(body.result.runnerId).toBe("checkout");
  expect(receipt.runId).toBe("run_load_1");
});
