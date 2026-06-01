import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { uploadToCloud, type UploadResultPayload } from "./upload.js";

const payload: UploadResultPayload = {
  runAt: "2026-05-29T00:00:00.000Z",
  summary: {
    total: 1,
    passed: 1,
    failed: 0,
    skipped: 0,
    durationMs: 12,
  },
  tests: [
    {
      testId: "smoke",
      testName: "smoke",
      success: true,
      durationMs: 12,
      events: [],
    },
  ],
};

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

test("uploadToCloud returns an uploaded receipt with run identity", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        runId: "run_123",
        url: "https://app.glubean.com/runs/run_123",
      }),
      { status: 201, headers: { "Content-Type": "application/json" } },
    ),
  );
  vi.stubGlobal("fetch", fetchMock);

  const receipt = await uploadToCloud(payload, {
    apiUrl: "https://api.glubean.test",
    token: "gb_test",
    projectId: "proj_123",
    rootDir,
  });

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(receipt).toMatchObject({
    schemaVersion: "glubean.upload-receipt.v1",
    apiUrl: "https://api.glubean.test",
    projectId: "proj_123",
    runId: "run_123",
    url: "https://app.glubean.com/runs/run_123",
    resultUpload: {
      status: "uploaded",
      runId: "run_123",
      url: "https://app.glubean.com/runs/run_123",
      statusCode: 201,
    },
    artifactUpload: {
      status: "skipped",
      attempted: false,
      count: 0,
    },
  });
  expect(receipt.uploadedAt).toEqual(expect.any(String));
});

test("uploadToCloud sends default environment when no env file is provided", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        runId: "run_123",
        url: "https://app.glubean.com/runs/run_123",
      }),
      { status: 201, headers: { "Content-Type": "application/json" } },
    ),
  );
  vi.stubGlobal("fetch", fetchMock);

  await uploadToCloud(payload, {
    apiUrl: "https://api.glubean.test",
    token: "gb_test",
    projectId: "proj_123",
    rootDir,
  });

  const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
  expect(body.environment).toBe("default");
});

test("uploadToCloud derives environment from dot-env file name", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        runId: "run_123",
        url: "https://app.glubean.com/runs/run_123",
      }),
      { status: 201, headers: { "Content-Type": "application/json" } },
    ),
  );
  vi.stubGlobal("fetch", fetchMock);

  await uploadToCloud(payload, {
    apiUrl: "https://api.glubean.test",
    token: "gb_test",
    projectId: "proj_123",
    envFile: ".env.staging",
    rootDir,
  });

  const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
  expect(body.environment).toBe("staging");
});

test("uploadToCloud lets GLUBEAN_ENV override env file label", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        runId: "run_123",
        url: "https://app.glubean.com/runs/run_123",
      }),
      { status: 201, headers: { "Content-Type": "application/json" } },
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("GLUBEAN_ENV", "preview-us");

  await uploadToCloud(payload, {
    apiUrl: "https://api.glubean.test",
    token: "gb_test",
    projectId: "proj_123",
    envFile: ".env.staging",
    rootDir,
  });

  const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
  expect(body.environment).toBe("preview-us");
});

test("uploadToCloud returns a failed receipt when result upload is rejected", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(
    new Response("unauthorized", { status: 401 }),
  );
  vi.stubGlobal("fetch", fetchMock);

  const receipt = await uploadToCloud(payload, {
    apiUrl: "https://api.glubean.test",
    token: "gb_bad",
    projectId: "proj_123",
    rootDir,
  });

  expect(receipt).toMatchObject({
    schemaVersion: "glubean.upload-receipt.v1",
    apiUrl: "https://api.glubean.test",
    projectId: "proj_123",
    resultUpload: {
      status: "failed",
      statusCode: 401,
      error: "unauthorized",
    },
    artifactUpload: {
      status: "skipped",
      attempted: false,
      count: 0,
    },
  });
});
