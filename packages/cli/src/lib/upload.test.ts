import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  removeUploadedScreenshots,
  uploadToCloud,
  type UploadedArtifactFile,
  type UploadRunInput,
} from "./upload.js";

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
    JSON.stringify({
      id,
      projectId: "proj_123",
      targetId: "tgt_123",
      kind: "test",
      url: `https://app.glubean.test/p/proj_123/targets/tgt_123/runs/${id}`,
    }),
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

test("uploadToCloud uses the server-returned canonical app deep link", async () => {
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
    url: "https://app.glubean.test/p/proj_123/targets/tgt_123/runs/run_123",
    resultUpload: {
      status: "uploaded",
      runId: "run_123",
      url: "https://app.glubean.test/p/proj_123/targets/tgt_123/runs/run_123",
      statusCode: 201,
    },
    artifactUpload: { status: "skipped", attempted: false, count: 0 },
  });
  expect(receipt.uploadedAt).toEqual(expect.any(String));
});

// ── Regression: GLU-109 — trailing-slash apiUrl must not double-slash the
// request. A `--api-url` / `GLUBEAN_API_URL` copied with a trailing slash is
// a common artifact; Hono's exact-segment router 404s on the resulting
// `//v1/...` double slash instead of matching `/v1/projects/...`. ──────────
test("uploadToCloud normalizes a trailing-slash apiUrl (no double slash in the runs endpoint)", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(runResponse());
  vi.stubGlobal("fetch", fetchMock);

  const receipt = await uploadToCloud(input, {
    ...baseOptions,
    apiUrl: "https://api.glubean.test/",
    rootDir,
  });

  const [url] = fetchMock.mock.calls[0];
  expect(url).toBe("https://api.glubean.test/v1/projects/proj_123/targets/tgt_123/runs");
  expect(url).not.toMatch(/\/\/v1\//);
  expect(receipt.resultUpload.status).toBe("uploaded");
  expect(receipt.url).toBe("https://app.glubean.test/p/proj_123/targets/tgt_123/runs/run_123");
});

test("uploadToCloud never guesses an app URL when an older server omits it", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(
    new Response(JSON.stringify({ id: "run_legacy", projectId: "proj_123", targetId: "tgt_123" }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);

  const receipt = await uploadToCloud(input, { ...baseOptions, rootDir });

  expect(receipt.resultUpload.status).toBe("uploaded");
  expect(receipt.url).toBeUndefined();
  expect(receipt.resultUpload.url).toBeUndefined();
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Cloud did not return an app URL"));
});

test("uploadToCloud normalizes a multi-trailing-slash apiUrl for the artifact endpoint too", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(runResponse())
    .mockResolvedValueOnce(artifactResponse());
  vi.stubGlobal("fetch", fetchMock);

  const shotsDir = join(rootDir, ".glubean", "screenshots", "mytest");
  await mkdir(shotsDir, { recursive: true });
  const screenshotPath = join(shotsDir, "shot.png");
  await writeFile(screenshotPath, Buffer.from("x"));

  await uploadToCloud(input, {
    ...baseOptions,
    apiUrl: "https://api.glubean.test///",
    rootDir,
    screenshotPaths: [screenshotPath],
  });

  expect(fetchMock).toHaveBeenCalledTimes(2);
  const [artifactUrl] = fetchMock.mock.calls[1];
  expect(artifactUrl).toBe(
    "https://api.glubean.test/v1/projects/proj_123/targets/tgt_123/runs/run_123/artifacts",
  );
  expect(artifactUrl).not.toMatch(/\/\/v1\//);
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

// ── ART1-B — uploadedPaths receipt field + post-upload local cleanup ──────

/** Does a path exist on disk? (stat-based, no fs.existsSync in this suite) */
async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Build the upload-time identity record for a file, as uploadToCloud would. */
async function fileIdentity(p: string): Promise<UploadedArtifactFile> {
  const real = await realpath(p);
  const s = await stat(real);
  return { path: real, size: s.size, mtimeMs: s.mtimeMs, ino: s.ino, dev: s.dev };
}

test("a confirmed artifact batch reports uploadedFiles (posted files only)", async () => {
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

  expect(receipt.artifactUpload.status).toBe("uploaded");
  // Whitelist candidates are realpath'd — compare against realpaths.
  const uploadedPaths = receipt.artifactUpload.uploadedFiles?.map((f) => f.path);
  expect(uploadedPaths?.slice().sort()).toEqual(
    [await realpath(shot1), await realpath(shot2)].sort(),
  );
  expect(uploadedPaths).not.toContain(stale);
  // Each entry carries the upload-time stat identity for the cleanup check.
  for (const f of receipt.artifactUpload.uploadedFiles ?? []) {
    expect(f).toMatchObject(await fileIdentity(f.path));
  }
});

test("uploadedFiles excludes files skipped for the inline cap", async () => {
  const shotsDir = join(rootDir, ".glubean", "screenshots", "mytest");
  await mkdir(shotsDir, { recursive: true });
  const small = join(shotsDir, "small.png");
  const big = join(shotsDir, "big.png");
  await writeFile(small, "png-small");
  await writeFile(big, Buffer.alloc(513 * 1024)); // > 512KB inline cap

  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(runResponse())
    .mockResolvedValueOnce(artifactResponse());
  vi.stubGlobal("fetch", fetchMock);

  const receipt = await uploadToCloud(input, {
    ...baseOptions,
    rootDir,
    screenshotPaths: [small, big],
  });

  expect(receipt.artifactUpload).toMatchObject({
    status: "uploaded",
    count: 1,
    skipped: 1,
  });
  // The over-cap file never reached the server — it must NOT be reported as
  // uploaded (or the cleanup would delete a file the Cloud never received).
  expect(receipt.artifactUpload.uploadedFiles?.map((f) => f.path)).toEqual([
    await realpath(small),
  ]);
});

test("a failed artifact POST reports no uploadedFiles", async () => {
  const shotsDir = join(rootDir, ".glubean", "screenshots", "mytest");
  await mkdir(shotsDir, { recursive: true });
  const shot1 = join(shotsDir, "shot-1.png");
  await writeFile(shot1, "png-1");

  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(runResponse())
    .mockResolvedValueOnce(new Response("bad request", { status: 400 }));
  vi.stubGlobal("fetch", fetchMock);

  const receipt = await uploadToCloud(input, {
    ...baseOptions,
    rootDir,
    screenshotPaths: [shot1],
  });

  expect(receipt.artifactUpload.status).toBe("failed");
  expect(receipt.artifactUpload.uploadedFiles).toBeUndefined();
});

test("upload then cleanup removes exactly this run's confirmed screenshots", async () => {
  // The real ART1-B flow: whitelist upload succeeds, then the CLI unlinks the
  // uploaded local copies — the stale prior-run file must survive untouched.
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
  const { removed } = await removeUploadedScreenshots(
    rootDir,
    [shot1, shot2],
    receipt.artifactUpload.uploadedFiles ?? [],
  );

  expect(removed).toBe(2);
  expect(await exists(shot1)).toBe(false);
  expect(await exists(shot2)).toBe(false);
  expect(await exists(stale)).toBe(true);
});

test("removeUploadedScreenshots unlinks only the uploaded ∩ this-run intersection", async () => {
  const shotsDir = join(rootDir, ".glubean", "screenshots", "mytest");
  await mkdir(shotsDir, { recursive: true });
  const uploadedShot = join(shotsDir, "uploaded.png");
  const notUploaded = join(shotsDir, "over-cap-never-uploaded.png");
  const stale = join(shotsDir, "stale-prev-run.png");
  await writeFile(uploadedShot, "png-1");
  await writeFile(notUploaded, "png-2");
  await writeFile(stale, "png-stale");

  const { removed } = await removeUploadedScreenshots(
    rootDir,
    [uploadedShot, notUploaded], // this run's list
    [await fileIdentity(uploadedShot)], // only this one was server-confirmed
  );

  expect(removed).toBe(1);
  expect(await exists(uploadedShot)).toBe(false);
  // In this run but never confirmed uploaded (e.g. over the inline cap) — kept.
  expect(await exists(notUploaded)).toBe(true);
  // On disk but not in this run's list — never eligible.
  expect(await exists(stale)).toBe(true);
});

test("removeUploadedScreenshots never deletes outside .glubean/screenshots", async () => {
  await mkdir(join(rootDir, ".glubean", "screenshots"), { recursive: true });
  // An adversarial/broken event path resolving into `.glubean/artifacts` that
  // ALSO appears uploaded (via the artifacts walk) — containment must win.
  const artifactsDir = join(rootDir, ".glubean", "artifacts");
  await mkdir(artifactsDir, { recursive: true });
  const dump = join(artifactsDir, "dump.bin");
  await writeFile(dump, "bin");

  const { removed } = await removeUploadedScreenshots(
    rootDir,
    [dump],
    [await fileIdentity(dump)],
  );

  expect(removed).toBe(0);
  expect(await exists(dump)).toBe(true);
});

test("removeUploadedScreenshots keeps a file recreated at the same path after upload", async () => {
  // TOCTOU (codex r1 P1): a concurrent run recreates the same screenshot path
  // between this run's upload and its cleanup. The bytes now on disk were
  // never received by the server — the stat-identity check must keep them.
  const shotsDir = join(rootDir, ".glubean", "screenshots", "mytest");
  await mkdir(shotsDir, { recursive: true });
  const shot1 = join(shotsDir, "shot-1.png");
  await writeFile(shot1, "png-original");
  const uploaded = [await fileIdentity(shot1)]; // identity at upload time

  // Concurrent run replaces the file (different size ⇒ identity mismatch even
  // if inode is reused by an in-place truncating write).
  await writeFile(shot1, "png-REPLACED-by-a-concurrent-run");

  const { removed } = await removeUploadedScreenshots(rootDir, [shot1], uploaded);

  expect(removed).toBe(0);
  expect(await exists(shot1)).toBe(true);
});

test("removeUploadedScreenshots is idempotent and no-ops without the dir", async () => {
  const shotsDir = join(rootDir, ".glubean", "screenshots", "mytest");
  await mkdir(shotsDir, { recursive: true });
  const shot1 = join(shotsDir, "shot-1.png");
  await writeFile(shot1, "png-1");
  const uploaded = [await fileIdentity(shot1)];

  const first = await removeUploadedScreenshots(rootDir, [shot1], uploaded);
  const second = await removeUploadedScreenshots(rootDir, [shot1], uploaded);
  expect(first.removed).toBe(1);
  expect(second.removed).toBe(0); // already gone — silently skipped

  // Missing screenshots dir entirely → no-op.
  const emptyRoot = await mkdtemp(join(tmpdir(), "glubean-cleanup-test-"));
  try {
    const none = await removeUploadedScreenshots(emptyRoot, [shot1], uploaded);
    expect(none.removed).toBe(0);
  } finally {
    await rm(emptyRoot, { recursive: true, force: true });
  }
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
