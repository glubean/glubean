import { test, expect } from "vitest";
import { join } from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { loadEnvFile, loadProjectEnv, expandVars } from "./env.js";

test("loadEnvFile: parses key=value pairs", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "glubean-env-test-"));
  const envPath = join(tmp, ".env");
  await writeFile(envPath, "FOO=bar\nBAZ=qux\n", "utf-8");

  const vars = await loadEnvFile(envPath);
  expect(vars.FOO).toBe("bar");
  expect(vars.BAZ).toBe("qux");

  await rm(tmp, { recursive: true, force: true });
});

test("loadEnvFile: returns empty for missing file", async () => {
  const vars = await loadEnvFile("/nonexistent/.env.nope");
  expect(vars).toEqual({});
});

test("loadProjectEnv: merges .env and .env.secrets", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "glubean-env-test-"));
  await writeFile(join(tmp, ".env"), "A=1\nB=2\n", "utf-8");
  await writeFile(join(tmp, ".env.secrets"), "B=override\nC=3\n", "utf-8");

  const vars = await loadProjectEnv(tmp);
  expect(vars.A).toBe("1");
  expect(vars.B).toBe("override"); // secrets wins
  expect(vars.C).toBe("3");

  await rm(tmp, { recursive: true, force: true });
});

test("loadProjectEnv: custom envFileName", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "glubean-env-test-"));
  await writeFile(join(tmp, ".env.staging"), "STAGE=true\n", "utf-8");
  await writeFile(join(tmp, ".env.staging.secrets"), "TOKEN=secret\n", "utf-8");

  const vars = await loadProjectEnv(tmp, ".env.staging");
  expect(vars.STAGE).toBe("true");
  expect(vars.TOKEN).toBe("secret");

  await rm(tmp, { recursive: true, force: true });
});

test("loadProjectEnv: missing files return empty", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "glubean-env-test-"));
  const vars = await loadProjectEnv(tmp);
  expect(vars).toEqual({});
  await rm(tmp, { recursive: true, force: true });
});

// --- expandVars tests ---

test("expandVars: expands ${NAME} from process.env", () => {
  process.env.__TEST_HOST_KEY = "secret123";
  const result = expandVars({ API_KEY: "${__TEST_HOST_KEY}" });
  expect(result.API_KEY).toBe("secret123");
  delete process.env.__TEST_HOST_KEY;
});

test("expandVars: expands ${NAME} from same-file earlier value", () => {
  const result = expandVars({
    BASE: "https://api.example.com",
    URL: "${BASE}/v1",
  });
  expect(result.URL).toBe("https://api.example.com/v1");
});

test("expandVars: missing reference resolves to empty string", () => {
  const result = expandVars({ KEY: "${DOES_NOT_EXIST_ANYWHERE}" });
  expect(result.KEY).toBe("");
});

test("expandVars: prefix and suffix around ${NAME}", () => {
  process.env.__TEST_REGION = "us-east-1";
  const result = expandVars({ BUCKET: "my-bucket-${__TEST_REGION}-data" });
  expect(result.BUCKET).toBe("my-bucket-us-east-1-data");
  delete process.env.__TEST_REGION;
});

test("loadProjectEnv: expands ${NAME} in merged env + secrets", async () => {
  process.env.__TEST_HOST_TOKEN = "tok_live_abc";
  const tmp = await mkdtemp(join(tmpdir(), "glubean-env-test-"));
  await writeFile(join(tmp, ".env"), "BASE_URL=https://api.example.com\n", "utf-8");
  await writeFile(join(tmp, ".env.secrets"), "API_KEY=${__TEST_HOST_TOKEN}\nFULL_URL=${BASE_URL}/graphql\n", "utf-8");

  const vars = await loadProjectEnv(tmp);
  expect(vars.API_KEY).toBe("tok_live_abc");
  expect(vars.FULL_URL).toBe("https://api.example.com/graphql");

  delete process.env.__TEST_HOST_TOKEN;
  await rm(tmp, { recursive: true, force: true });
});
