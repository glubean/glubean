/**
 * Tests for credential resolution logic.
 */

import { afterEach, test, expect, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  checkTargetInProject,
  checkUploadAuth,
  readCredentials,
  resolveApiUrl,
  resolveAuthUrl,
  resolveDefaultTargetId,
  resolveProjectId,
  resolveTargetId,
  resolveToken,
  writeCredentials,
} from "./auth.js";
import { DEFAULT_API_URL } from "./constants.js";

const AUTH_ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "GLUBEAN_TOKEN",
  "GLUBEAN_PROJECT_ID",
  "GLUBEAN_TARGET_ID",
  "GLUBEAN_API_URL",
  "GLUBEAN_PLATFORM_API_URL",
  "GLUBEAN_AUTH_URL",
];

function saveEnv(): Map<string, string | undefined> {
  const saved = new Map<string, string | undefined>();
  for (const key of AUTH_ENV_KEYS) {
    saved.set(key, process.env[key]);
  }
  return saved;
}

function restoreEnv(saved: Map<string, string | undefined>): void {
  for (const [key, value] of saved) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

async function withTempHome(
  fn: (tmpHome: string) => Promise<void>,
): Promise<void> {
  const tmpHome = await mkdtemp(join(tmpdir(), "glubean-auth-test-"));
  const saved = saveEnv();
  try {
    process.env["HOME"] = tmpHome;
    delete process.env["USERPROFILE"];
    delete process.env["GLUBEAN_TOKEN"];
    delete process.env["GLUBEAN_PROJECT_ID"];
    delete process.env["GLUBEAN_API_URL"];
    delete process.env["GLUBEAN_PLATFORM_API_URL"];
    await fn(tmpHome);
  } finally {
    restoreEnv(saved);
    await rm(tmpHome, { recursive: true, force: true }).catch(() => {});
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── writeCredentials + readCredentials roundtrip ──

test("writeCredentials + readCredentials roundtrip", async () => {
  await withTempHome(async (tmpHome) => {
    const creds = { token: "gb_test123", projectId: "proj_abc", apiUrl: "https://custom.api.com" };
    const path = await writeCredentials(creds);

    expect(path).toBe(join(tmpHome, ".glubean", "credentials.json"));

    const loaded = await readCredentials();
    expect(loaded?.token).toBe("gb_test123");
    expect(loaded?.projectId).toBe("proj_abc");
    expect(loaded?.apiUrl).toBe("https://custom.api.com");
  });
});

test("readCredentials returns null when no file exists", async () => {
  await withTempHome(async () => {
    const result = await readCredentials();
    expect(result).toBe(null);
  });
});

// ── resolveToken ──

test("resolveToken: flag takes priority over env and file", async () => {
  await withTempHome(async () => {
    await writeCredentials({ token: "gb_file" });
    process.env["GLUBEAN_TOKEN"] = "gb_env";

    const token = await resolveToken({ token: "gb_flag" });
    expect(token).toBe("gb_flag");
  });
});

test("resolveToken: env takes priority over file", async () => {
  await withTempHome(async () => {
    await writeCredentials({ token: "gb_file" });
    process.env["GLUBEAN_TOKEN"] = "gb_env";

    const token = await resolveToken({});
    expect(token).toBe("gb_env");
  });
});

test("resolveToken: falls back to credentials file", async () => {
  await withTempHome(async () => {
    await writeCredentials({ token: "gb_file" });

    const token = await resolveToken({});
    expect(token).toBe("gb_file");
  });
});

test("resolveToken: returns null when nothing available", async () => {
  await withTempHome(async () => {
    const token = await resolveToken({});
    expect(token).toBe(null);
  });
});

test("resolveToken: tokenEnv resolves the per-profile token from envFileVars", async () => {
  await withTempHome(async () => {
    const sources = { envFileVars: { TOKEN_PROFILE_A: "gb_a" } };
    const token = await resolveToken({}, sources, "TOKEN_PROFILE_A");
    expect(token).toBe("gb_a");
  });
});

test("resolveToken: tokenEnv does NOT fall back to GLUBEAN_TOKEN when its var is empty", async () => {
  await withTempHome(async () => {
    // A default GLUBEAN_TOKEN exists, but the profile points at a different,
    // unset var — must NOT silently use the default (wrong-token-to-wrong-project).
    process.env["GLUBEAN_TOKEN"] = "gb_default";
    const token = await resolveToken({}, { envFileVars: {} }, "TOKEN_PROFILE_A");
    expect(token).toBe(null);
  });
});

test("resolveToken: explicit --token still wins over tokenEnv", async () => {
  await withTempHome(async () => {
    const sources = { envFileVars: { TOKEN_PROFILE_A: "gb_a" } };
    const token = await resolveToken({ token: "gb_flag" }, sources, "TOKEN_PROFILE_A");
    expect(token).toBe("gb_flag");
  });
});

test("resolveToken: tokenEnv prefers system env over envFileVars", async () => {
  await withTempHome(async () => {
    process.env["TOKEN_PROFILE_A"] = "gb_sys";
    try {
      const sources = { envFileVars: { TOKEN_PROFILE_A: "gb_file" } };
      const token = await resolveToken({}, sources, "TOKEN_PROFILE_A");
      expect(token).toBe("gb_sys");
    } finally {
      delete process.env["TOKEN_PROFILE_A"];
    }
  });
});

test("resolveToken: an empty tokenEnv system var is treated as absent, so .env.secrets wins", async () => {
  await withTempHome(async () => {
    process.env["TOKEN_PROFILE_A"] = ""; // present but empty
    try {
      const sources = { envFileVars: { TOKEN_PROFILE_A: "gb_secret" } };
      const token = await resolveToken({}, sources, "TOKEN_PROFILE_A");
      expect(token).toBe("gb_secret");
    } finally {
      delete process.env["TOKEN_PROFILE_A"];
    }
  });
});

// ── resolveProjectId ──

test("resolveProjectId: flag takes priority", async () => {
  await withTempHome(async () => {
    await writeCredentials({ token: "gb_x", projectId: "proj_file" });
    process.env["GLUBEAN_PROJECT_ID"] = "proj_env";

    const pid = await resolveProjectId({ project: "proj_flag" });
    expect(pid).toBe("proj_flag");
  });
});

test("resolveProjectId: env takes priority over file", async () => {
  await withTempHome(async () => {
    await writeCredentials({ token: "gb_x", projectId: "proj_file" });
    process.env["GLUBEAN_PROJECT_ID"] = "proj_env";

    const pid = await resolveProjectId({});
    expect(pid).toBe("proj_env");
  });
});

test("resolveProjectId: falls back to credentials file", async () => {
  await withTempHome(async () => {
    await writeCredentials({ token: "gb_x", projectId: "proj_file" });

    const pid = await resolveProjectId({});
    expect(pid).toBe("proj_file");
  });
});

test("resolveProjectId: returns null when nothing available", async () => {
  await withTempHome(async () => {
    const pid = await resolveProjectId({});
    expect(pid).toBe(null);
  });
});

// ── resolveApiUrl ──

test("resolveApiUrl: flag takes priority over env", async () => {
  await withTempHome(async () => {
    await writeCredentials({ token: "gb_x", apiUrl: "https://file.api.com" });
    process.env["GLUBEAN_API_URL"] = "https://env.api.com";

    const url = await resolveApiUrl({ apiUrl: "https://flag.api.com" });
    expect(url).toBe("https://flag.api.com");
  });
});

test("resolveApiUrl: flag used when no env", async () => {
  await withTempHome(async () => {
    const url = await resolveApiUrl({ apiUrl: "https://flag.api.com" });
    expect(url).toBe("https://flag.api.com");
  });
});

test("resolveApiUrl: falls back to credentials file", async () => {
  await withTempHome(async () => {
    await writeCredentials({ token: "gb_x", apiUrl: "https://file.api.com" });

    const url = await resolveApiUrl({});
    expect(url).toBe("https://file.api.com");
  });
});

test("resolveApiUrl: defaults to DEFAULT_API_URL", async () => {
  await withTempHome(async () => {
    const url = await resolveApiUrl({});
    expect(url).toBe(DEFAULT_API_URL);
  });
});

// ── GLU-161: GLUBEAN_PLATFORM_API_URL outranks the legacy GLUBEAN_API_URL.
// Mirrors GLU-139's fix for the MCP server (packages/mcp/src/cloud.ts /
// cloud.test.ts) — a project (e.g. the dogfood repo) can legitimately set
// GLUBEAN_API_URL for an unrelated Dashboard API (server-hono, no `/v1/*`)
// while also setting GLUBEAN_PLATFORM_API_URL for the Platform/ingest API
// `run --upload` / `load --upload` / `sync` need. GLUBEAN_PLATFORM_API_URL
// must win so those commands don't 404 against the Dashboard host when
// relying on project env resolution (no explicit --api-url). ──────────────

test("resolveApiUrl: prefers GLUBEAN_PLATFORM_API_URL over GLUBEAN_API_URL (process env)", async () => {
  await withTempHome(async () => {
    process.env["GLUBEAN_API_URL"] = "https://api.staging.glubean.com";
    process.env["GLUBEAN_PLATFORM_API_URL"] = "https://platform.staging.glubean.com";
    const url = await resolveApiUrl({});
    expect(url).toBe("https://platform.staging.glubean.com");
  });
});

test("resolveApiUrl: falls back to GLUBEAN_API_URL when GLUBEAN_PLATFORM_API_URL is unset (legacy projects)", async () => {
  await withTempHome(async () => {
    process.env["GLUBEAN_API_URL"] = "https://platform.glubean.com";
    const url = await resolveApiUrl({});
    expect(url).toBe("https://platform.glubean.com");
  });
});

test("resolveApiUrl: an explicit --api-url flag still overrides both platform and legacy env vars", async () => {
  await withTempHome(async () => {
    process.env["GLUBEAN_API_URL"] = "https://api.staging.glubean.com";
    process.env["GLUBEAN_PLATFORM_API_URL"] = "https://platform.staging.glubean.com";
    const url = await resolveApiUrl({ apiUrl: "https://explicit.test" });
    expect(url).toBe("https://explicit.test");
  });
});

test("resolveApiUrl: reads GLUBEAN_PLATFORM_API_URL from .env file vars, same precedence as process env", async () => {
  await withTempHome(async () => {
    process.env["GLUBEAN_API_URL"] = "https://api.staging.glubean.com";
    const url = await resolveApiUrl(
      {},
      { envFileVars: { GLUBEAN_PLATFORM_API_URL: "https://platform.staging.glubean.com" } },
    );
    expect(url).toBe("https://platform.staging.glubean.com");
  });
});

test("resolveApiUrl: a process-env GLUBEAN_PLATFORM_API_URL beats a .env-file GLUBEAN_API_URL", async () => {
  await withTempHome(async () => {
    process.env["GLUBEAN_PLATFORM_API_URL"] = "https://platform.staging.glubean.com";
    const url = await resolveApiUrl(
      {},
      { envFileVars: { GLUBEAN_API_URL: "https://api.staging.glubean.com" } },
    );
    expect(url).toBe("https://platform.staging.glubean.com");
  });
});

test("resolveApiUrl: when BOTH vars land in the same envFileVars object (run/load/sync's { ...vars, ...secrets } merge), GLUBEAN_PLATFORM_API_URL still wins", async () => {
  await withTempHome(async () => {
    const url = await resolveApiUrl(
      {},
      {
        envFileVars: {
          GLUBEAN_API_URL: "https://api.staging.glubean.com",
          GLUBEAN_PLATFORM_API_URL: "https://platform.staging.glubean.com",
        },
      },
    );
    expect(url).toBe("https://platform.staging.glubean.com");
  });
});

// ── Regression: GLU-109 / GLU-61 family — trailing-slash apiUrl must not
// double-slash `/v1/...` request URLs. A copy-pasted `--api-url` /
// `GLUBEAN_API_URL` with a trailing slash (browser address bar, docs
// examples) previously survived unnormalized through every preflight check
// in this file, producing `https://host//v1/projects/...`. Hono's exact
// segment router doesn't collapse that double slash, so it 404s instead of
// matching `/v1/projects/:id` — even though the SAME project is a real 200
// once the slash is stripped. `upload.ts` / `sync.ts` already normalized;
// this brings `resolveApiUrl` (and everything that calls it) in line. ──────

test("resolveApiUrl: strips a trailing slash from the --api-url flag", async () => {
  await withTempHome(async () => {
    const url = await resolveApiUrl({ apiUrl: "https://api.glubean.test/" });
    expect(url).toBe("https://api.glubean.test");
  });
});

test("resolveApiUrl: strips multiple trailing slashes from GLUBEAN_API_URL", async () => {
  await withTempHome(async () => {
    process.env["GLUBEAN_API_URL"] = "https://api.glubean.test///";
    const url = await resolveApiUrl({});
    expect(url).toBe("https://api.glubean.test");
  });
});

test("resolveApiUrl: strips a trailing slash from envFileVars / cloudConfig / credentials.json", async () => {
  await withTempHome(async () => {
    expect(
      await resolveApiUrl({}, { envFileVars: { GLUBEAN_API_URL: "https://env-file.test/" } }),
    ).toBe("https://env-file.test");
    expect(
      await resolveApiUrl({}, { cloudConfig: { apiUrl: "https://config.test/" } }),
    ).toBe("https://config.test");

    await writeCredentials({ token: "gb_x", apiUrl: "https://creds.test/" });
    expect(await resolveApiUrl({})).toBe("https://creds.test");
  });
});

test("checkUploadAuth: a trailing-slash apiUrl still GETs the single-slash /v1/projects/:id URL (no 404)", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(
    new Response(JSON.stringify({ id: "proj_1", name: "Acme" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const r = await checkUploadAuth("https://api.glubean.test/", "proj_1", "glb_ok");
  expect(fetchMock.mock.calls[0][0]).toBe("https://api.glubean.test/v1/projects/proj_1");
  expect(r).toMatchObject({ proceed: true, status: 200 });
});

test("checkTargetInProject: a trailing-slash apiUrl still GETs the single-slash target URL (no 404)", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(
    new Response(JSON.stringify({ id: "tgt_1" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const r = await checkTargetInProject("https://api.glubean.test/", "proj_1", "tgt_1", "glb_ok");
  expect(fetchMock.mock.calls[0][0]).toBe(
    "https://api.glubean.test/v1/projects/proj_1/targets/tgt_1",
  );
  expect(r).toMatchObject({ proceed: true, status: 200 });
});

test("resolveDefaultTargetId: a trailing-slash apiUrl still GETs the single-slash targets URL", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(
    new Response(JSON.stringify([{ id: "tgt_only", slug: "prod" }]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const id = await resolveDefaultTargetId("https://api.glubean.test/", "prj_custom", "gb");
  expect(fetchMock.mock.calls[0][0]).toBe("https://api.glubean.test/v1/projects/prj_custom/targets");
  expect(id).toBe("tgt_only");
});

// ── ProjectAuthSources tests ──

test("resolveToken: envFileVars used when no flag or system env", async () => {
  await withTempHome(async () => {
    const sources = { envFileVars: { GLUBEAN_TOKEN: "gb_from_dotenv" } };
    const token = await resolveToken({}, sources);
    expect(token).toBe("gb_from_dotenv");
  });
});

test("resolveToken: system env takes priority over envFileVars", async () => {
  await withTempHome(async () => {
    process.env["GLUBEAN_TOKEN"] = "gb_system";
    const sources = { envFileVars: { GLUBEAN_TOKEN: "gb_from_dotenv" } };
    const token = await resolveToken({}, sources);
    expect(token).toBe("gb_system");
  });
});

test("resolveProjectId: cloudConfig used when no flag, env, or envFileVars", async () => {
  await withTempHome(async () => {
    const sources = { cloudConfig: { projectId: "proj_from_config" } };
    const id = await resolveProjectId({}, sources);
    expect(id).toBe("proj_from_config");
  });
});

test("resolveProjectId: envFileVars takes priority over cloudConfig", async () => {
  await withTempHome(async () => {
    const sources = {
      envFileVars: { GLUBEAN_PROJECT_ID: "proj_from_dotenv" },
      cloudConfig: { projectId: "proj_from_config" },
    };
    const id = await resolveProjectId({}, sources);
    expect(id).toBe("proj_from_dotenv");
  });
});

test("resolveApiUrl: cloudConfig used when no flag, env, or envFileVars", async () => {
  await withTempHome(async () => {
    const sources = { cloudConfig: { apiUrl: "https://config.api.com" } };
    const url = await resolveApiUrl({}, sources);
    expect(url).toBe("https://config.api.com");
  });
});

// ── Auth-plane URL (server-hono / device login) ──────────────────────────────

test("resolveAuthUrl: --auth-url flag wins over env and default", async () => {
  const saved = saveEnv();
  try {
    process.env.GLUBEAN_AUTH_URL = "https://api.glubean.test";
    expect(await resolveAuthUrl({ authUrl: "https://flag.example" })).toBe("https://flag.example");
  } finally {
    restoreEnv(saved);
  }
});

test("resolveAuthUrl: GLUBEAN_AUTH_URL used when no flag", async () => {
  const saved = saveEnv();
  try {
    process.env.GLUBEAN_AUTH_URL = "https://api.glubean.test";
    expect(await resolveAuthUrl({})).toBe("https://api.glubean.test");
  } finally {
    restoreEnv(saved);
  }
});

test("resolveAuthUrl: defaults to DEFAULT_AUTH_URL when nothing set", async () => {
  await withTempHome(async () => {
    const saved = saveEnv();
    try {
      delete process.env.GLUBEAN_AUTH_URL;
      expect(await resolveAuthUrl({})).toBe("https://api.glubean.com");
    } finally {
      restoreEnv(saved);
    }
  });
});

// ── Target resolution ────────────────────────────────────────────────────────

test("resolveTargetId: --target flag takes priority over env/yaml", async () => {
  const saved = saveEnv();
  try {
    process.env.GLUBEAN_TARGET_ID = "tgt_env";
    const id = await resolveTargetId(
      { target: "tgt_flag" },
      { cloudConfig: { targetId: "tgt_yaml" } },
    );
    expect(id).toBe("tgt_flag");
  } finally {
    restoreEnv(saved);
  }
});

test("resolveTargetId: returns null when unset (server default-target fallback)", async () => {
  const saved = saveEnv();
  try {
    delete process.env.GLUBEAN_TARGET_ID;
    expect(await resolveTargetId({}, {})).toBeNull();
  } finally {
    restoreEnv(saved);
  }
});

test("resolveDefaultTargetId: derives a DEFAULT project's target with no network call (least-privilege tokens)", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const id = await resolveDefaultTargetId(
    "https://api.glubean.test",
    "proj_default_org123",
    "gb_runs_write_only",
  );
  expect(id).toBe("tgt_default_org123");
  // No `targets:read` GET — the id is deterministic for default projects.
  expect(fetchMock).not.toHaveBeenCalled();
});

test("resolveDefaultTargetId: lists targets for a non-default project and picks the default slug", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(
    new Response(
      JSON.stringify([
        { id: "tgt_a", slug: "api-a" },
        { id: "tgt_def", slug: "default" },
      ]),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  const id = await resolveDefaultTargetId("https://api.glubean.test", "prj_custom", "gb");
  expect(id).toBe("tgt_def");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("resolveDefaultTargetId: returns null when the targets GET is forbidden (missing targets:read)", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
  vi.stubGlobal("fetch", fetchMock);
  const id = await resolveDefaultTargetId("https://api.glubean.test", "prj_custom", "gb");
  expect(id).toBeNull();
});

test("resolveDefaultTargetId: returns null for a multi-target project with no default slug (ambiguous)", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(
    new Response(JSON.stringify([{ id: "tgt_a", slug: "a" }, { id: "tgt_b", slug: "b" }]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  expect(await resolveDefaultTargetId("https://api.glubean.test", "prj_custom", "gb")).toBeNull();
});

test("resolveDefaultTargetId: auto-picks the sole target of a single-target non-default project", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(
    new Response(JSON.stringify([{ id: "tgt_only", slug: "prod" }]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  expect(await resolveDefaultTargetId("https://api.glubean.test", "prj_custom", "gb")).toBe("tgt_only");
});

// ── Pre-upload auth check ────────────────────────────────────────────────────

test("checkUploadAuth: 200 verifies and returns the project name", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "proj_1", name: "Acme" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
  const r = await checkUploadAuth("https://api.glubean.test", "proj_1", "glb_ok");
  expect(r).toMatchObject({ proceed: true, status: 200, projectName: "Acme" });
});

test("checkUploadAuth: 403 insufficient_scope (least-privilege ingest token) proceeds unverified", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "insufficient_scope", required: "projects:read" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
  const r = await checkUploadAuth("https://api.glubean.test", "proj_1", "glb_runs_write");
  expect(r).toMatchObject({ proceed: true, status: 403, unverified: true });
});

test("checkUploadAuth: 403 no_membership does NOT proceed (token can't write runs either)", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "no_membership" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
  const r = await checkUploadAuth("https://api.glubean.test", "proj_1", "glb_no_org");
  expect(r).toMatchObject({ proceed: false, status: 403 });
});

test("checkUploadAuth: 401 (invalid/wrong-kind token) does not proceed", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("unauthorized", { status: 401 })));
  const r = await checkUploadAuth("https://api.glubean.test", "proj_1", "gb_old");
  expect(r).toMatchObject({ proceed: false, status: 401 });
});

test("checkUploadAuth: 404 (mistyped project / wrong API URL) does not proceed", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("not found", { status: 404 })));
  const r = await checkUploadAuth("https://api.glubean.test", "proj_typo", "glb_ok");
  expect(r).toMatchObject({ proceed: false, status: 404 });
});

test("checkUploadAuth: an unreachable server reports status 0 and does not proceed", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("ECONNREFUSED")));
  const r = await checkUploadAuth("https://api.glubean.test", "proj_1", "glb_ok");
  expect(r).toMatchObject({ proceed: false, status: 0 });
});

test("checkUploadAuth: a 2xx non-project response (wrong --api-url) does not proceed", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValueOnce(
      new Response("<html>proxy</html>", { status: 200, headers: { "Content-Type": "text/html" } }),
    ),
  );
  const r = await checkUploadAuth("https://api.glubean.test", "proj_1", "glb_ok");
  expect(r).toMatchObject({ proceed: false, status: 200 });
});

test("checkTargetInProject: 200 verifies an existing target; GETs the target path", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(
    new Response(JSON.stringify({ id: "tgt_1", name: "API" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const r = await checkTargetInProject("https://api.glubean.test", "proj_1", "tgt_1", "glb_ok");
  expect(r).toMatchObject({ proceed: true, status: 200 });
  expect(fetchMock.mock.calls[0][0]).toBe(
    "https://api.glubean.test/v1/projects/proj_1/targets/tgt_1",
  );
});

test("checkTargetInProject: 404 (mistyped target) does not proceed", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("not found", { status: 404 })));
  const r = await checkTargetInProject("https://api.glubean.test", "proj_1", "tgt_typo", "glb_ok");
  expect(r).toMatchObject({ proceed: false, status: 404 });
});

test("checkTargetInProject: 403 insufficient_scope proceeds unverified (no targets:read)", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "insufficient_scope" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
  const r = await checkTargetInProject("https://api.glubean.test", "proj_1", "tgt_1", "glb_runs_write");
  expect(r).toMatchObject({ proceed: true, status: 403, unverified: true });
});
