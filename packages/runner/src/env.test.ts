import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { expandVars, loadEnvFile, loadProjectEnv } from "./env.js";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "glubean-env-test-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("loadEnvFile (primitive)", () => {
  test("parses KEY=value pairs via dotenv", async () => {
    const p = join(tmp, ".env");
    await writeFile(p, "A=1\nB=two\nC=\"with space\"\n");
    const vars = await loadEnvFile(p);
    expect(vars).toEqual({ A: "1", B: "two", C: "with space" });
  });

  test("missing file returns empty object (ENOENT silent)", async () => {
    const vars = await loadEnvFile(join(tmp, ".env.nope"));
    expect(vars).toEqual({});
  });

  test("does NOT expand ${NAME} references — that's expandVars' job", async () => {
    const p = join(tmp, ".env");
    await writeFile(p, "HOST=example.com\nURL=https://${HOST}/api\n");
    const vars = await loadEnvFile(p);
    // Raw parse result: URL value stays as the literal string with `${HOST}`.
    expect(vars).toEqual({ HOST: "example.com", URL: "https://${HOST}/api" });
  });
});

describe("expandVars", () => {
  test("resolves ${NAME} references from same-pass values (insertion order)", () => {
    const result = expandVars({
      BASE: "https://api.example.com",
      USERS: "${BASE}/users",
    });
    expect(result).toEqual({
      BASE: "https://api.example.com",
      USERS: "https://api.example.com/users",
    });
  });

  test("falls back to process.env when reference is not in same-pass", () => {
    const prev = process.env["__TEST_EXPAND_HOST"];
    process.env["__TEST_EXPAND_HOST"] = "host.from.process";
    try {
      const result = expandVars({ URL: "https://${__TEST_EXPAND_HOST}/api" });
      expect(result).toEqual({ URL: "https://host.from.process/api" });
    } finally {
      if (prev === undefined) delete process.env["__TEST_EXPAND_HOST"];
      else process.env["__TEST_EXPAND_HOST"] = prev;
    }
  });

  test("missing reference expands to empty string", () => {
    const result = expandVars({ URL: "https://${UNDEFINED_VAR_XYZ}/api" });
    expect(result).toEqual({ URL: "https:///api" });
  });

  test("forward reference within insertion order (later key references earlier)", () => {
    // This is the intended behavior. Reverse direction would need multi-pass.
    const result = expandVars({
      A: "alpha",
      B: "${A}-beta",
      C: "${A}-${B}",
    });
    expect(result).toEqual({
      A: "alpha",
      B: "alpha-beta",
      C: "alpha-alpha-beta",
    });
  });
});

describe("loadProjectEnv — canonical split API", () => {
  test("returns { vars, secrets } with files loaded from rootDir", async () => {
    await writeFile(join(tmp, ".env"), "A=1\nB=2\n");
    await writeFile(join(tmp, ".env.secrets"), "TOKEN=abc\n");

    const result = await loadProjectEnv(tmp);
    expect(result).toEqual({
      vars: { A: "1", B: "2" },
      secrets: { TOKEN: "abc" },
    });
  });

  test("expands ${NAME} references ACROSS vars and secrets (vars→secrets direction)", async () => {
    await writeFile(join(tmp, ".env"), "HOST=api.example.com\n");
    await writeFile(
      join(tmp, ".env.secrets"),
      "API_URL=https://${HOST}/v1\nTOKEN=abc\n",
    );

    const { vars, secrets } = await loadProjectEnv(tmp);
    expect(vars).toEqual({ HOST: "api.example.com" });
    // secrets references vars — the cross-file expansion we're fixing.
    expect(secrets).toEqual({
      API_URL: "https://api.example.com/v1",
      TOKEN: "abc",
    });
  });

  test("expands ${NAME} within a single file", async () => {
    await writeFile(
      join(tmp, ".env"),
      "BASE=https://api.example.com\nUSERS=${BASE}/users\nORDERS=${BASE}/orders\n",
    );
    const { vars } = await loadProjectEnv(tmp);
    expect(vars).toEqual({
      BASE: "https://api.example.com",
      USERS: "https://api.example.com/users",
      ORDERS: "https://api.example.com/orders",
    });
  });

  test("expands ${NAME} from process.env when not in files", async () => {
    await writeFile(join(tmp, ".env"), "URL=https://${__TEST_HOST_EXT}/v1\n");
    const prev = process.env["__TEST_HOST_EXT"];
    process.env["__TEST_HOST_EXT"] = "external.example.com";
    try {
      const { vars } = await loadProjectEnv(tmp);
      expect(vars).toEqual({ URL: "https://external.example.com/v1" });
    } finally {
      if (prev === undefined) delete process.env["__TEST_HOST_EXT"];
      else process.env["__TEST_HOST_EXT"] = prev;
    }
  });

  test("key collision: secret wins, key appears only in secrets (not duplicated)", async () => {
    await writeFile(join(tmp, ".env"), "API_KEY=placeholder\nOTHER=x\n");
    await writeFile(join(tmp, ".env.secrets"), "API_KEY=real-secret\n");

    const { vars, secrets } = await loadProjectEnv(tmp);
    expect(vars).toEqual({ OTHER: "x" }); // API_KEY NOT in vars
    expect(secrets).toEqual({ API_KEY: "real-secret" });
  });

  test("missing files → empty vars / secrets", async () => {
    const result = await loadProjectEnv(tmp);
    expect(result).toEqual({ vars: {}, secrets: {} });
  });

  test("custom envFileName loads .env.staging + .env.staging.secrets", async () => {
    await writeFile(join(tmp, ".env.staging"), "HOST=staging.example.com\n");
    await writeFile(
      join(tmp, ".env.staging.secrets"),
      "TOKEN=stg-token\nURL=https://${HOST}/api\n",
    );

    const { vars, secrets } = await loadProjectEnv(tmp, ".env.staging");
    expect(vars).toEqual({ HOST: "staging.example.com" });
    expect(secrets).toEqual({
      TOKEN: "stg-token",
      URL: "https://staging.example.com/api",
    });
  });

  test("documented limitation: vars keys referencing secrets-only keys do NOT resolve in single pass", async () => {
    // Vars come first in insertion order. When we process vars' URL, TOKEN
    // (secrets-only) hasn't been resolved yet — falls back to process.env
    // (undefined) → empty string. Documented behavior.
    await writeFile(join(tmp, ".env"), "URL=Bearer ${TOKEN}\n");
    await writeFile(join(tmp, ".env.secrets"), "TOKEN=abc\n");

    const { vars } = await loadProjectEnv(tmp);
    // URL did not resolve TOKEN — this is the multi-pass limitation.
    expect(vars.URL).toBe("Bearer ");
  });
});
