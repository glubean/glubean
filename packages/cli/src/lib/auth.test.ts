/**
 * Tests for credential resolution logic.
 */

import { test, expect } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readCredentials, resolveApiUrl, resolveProjectId, resolveToken, writeCredentials } from "./auth.js";
import { DEFAULT_API_URL } from "./constants.js";

const AUTH_ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "GLUBEAN_TOKEN",
  "GLUBEAN_PROJECT_ID",
  "GLUBEAN_API_URL",
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
    await fn(tmpHome);
  } finally {
    restoreEnv(saved);
    await rm(tmpHome, { recursive: true, force: true }).catch(() => {});
  }
}

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
