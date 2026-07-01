import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  clientRunId: "crun-fixed-1",
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

function artifactResponse() {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Filenames of the multipart `files` parts on the artifact POST (2nd fetch). */
function uploadedNames(fetchMock: ReturnType<typeof vi.fn>): string[] {
  const form = fetchMock.mock.calls[1][1].body as FormData;
  return form.getAll("files").map((f) => (f as File).name);
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
  // idempotency id is sent so a lost-response retry replaces, not duplicates.
  expect(body.clientRunId).toBe("crun-fixed-1");

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

test("screenshotPaths whitelist uploads only this run's screenshots, not stale ones", async () => {
  // A screenshots dir that accumulated files across runs: two from THIS run
  // plus one left over from a PREVIOUS run (ART1 — the whole-dir walk would
  // have attached the stale file to this run).
  const shotsDir = join(rootDir, ".glubean", "screenshots", "mytest");
  await mkdir(shotsDir, { recursive: true });
  const shot1 = join(shotsDir, "shot-1.png");
  const shot2 = join(shotsDir, "shot-2.png");
  const stale = join(shotsDir, "stale-prev-run.png");
  await writeFile(shot1, "png-1");
  await writeFile(shot2, "png-2");
  await writeFile(stale, "png-stale");

  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(runResponse())
    .mockResolvedValueOnce(artifactResponse());
  vi.stubGlobal("fetch", fetchMock);

  const receipt = await uploadToCloud(input, {
    ...baseOptions,
    rootDir,
    screenshotPaths: [shot1, shot2],
  });

  expect(fetchMock).toHaveBeenCalledTimes(2);
  const names = uploadedNames(fetchMock);
  expect(names.sort()).toEqual([
    "screenshots/mytest/shot-1.png",
    "screenshots/mytest/shot-2.png",
  ]);
  expect(names).not.toContain("screenshots/mytest/stale-prev-run.png");
  expect(receipt.artifactUpload).toMatchObject({
    status: "uploaded",
    attempted: true,
    count: 2,
  });
});

test("screenshotPaths guard drops paths that escape the screenshots root", async () => {
  const shotsDir = join(rootDir, ".glubean", "screenshots", "mytest");
  await mkdir(shotsDir, { recursive: true });
  const shot1 = join(shotsDir, "shot-1.png");
  await writeFile(shot1, "png-1");
  // A secret outside the screenshots root that a malicious/broken event-stream
  // `path` (e.g. "../../.env") could point at — must never be read/uploaded.
  const secret = join(rootDir, "secret.env");
  await writeFile(secret, "API_KEY=super-secret");

  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(runResponse())
    .mockResolvedValueOnce(artifactResponse());
  vi.stubGlobal("fetch", fetchMock);

  const receipt = await uploadToCloud(input, {
    ...baseOptions,
    rootDir,
    screenshotPaths: [shot1, secret],
  });

  const names = uploadedNames(fetchMock);
  expect(names).toEqual(["screenshots/mytest/shot-1.png"]);
  expect(names).not.toContain("secret.env");
  expect(receipt.artifactUpload.count).toBe(1);
});

test("screenshotPaths whitelist skips a non-file entry (dir) without failing the batch", async () => {
  const shotsDir = join(rootDir, ".glubean", "screenshots", "mytest");
  await mkdir(shotsDir, { recursive: true });
  const shot1 = join(shotsDir, "shot-1.png");
  await writeFile(shot1, "png-1");
  // A directory whose path could arrive as a malformed screenshot event —
  // realpath-contained but not a regular file; reading it would throw.
  const subdir = join(shotsDir, "nested");
  await mkdir(subdir, { recursive: true });

  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(runResponse())
    .mockResolvedValueOnce(artifactResponse());
  vi.stubGlobal("fetch", fetchMock);

  const receipt = await uploadToCloud(input, {
    ...baseOptions,
    rootDir,
    screenshotPaths: [shot1, subdir],
  });

  const names = uploadedNames(fetchMock);
  expect(names).toEqual(["screenshots/mytest/shot-1.png"]);
  expect(receipt.artifactUpload).toMatchObject({ status: "uploaded", count: 1 });
});

test("without screenshotPaths the screenshots dir is walked (backward compatible)", async () => {
  const shotsDir = join(rootDir, ".glubean", "screenshots", "mytest");
  await mkdir(shotsDir, { recursive: true });
  await writeFile(join(shotsDir, "a.png"), "a");
  await writeFile(join(shotsDir, "b.png"), "b");

  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(runResponse())
    .mockResolvedValueOnce(artifactResponse());
  vi.stubGlobal("fetch", fetchMock);

  await uploadToCloud(input, { ...baseOptions, rootDir });

  const names = uploadedNames(fetchMock).sort();
  expect(names).toEqual([
    "screenshots/mytest/a.png",
    "screenshots/mytest/b.png",
  ]);
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
