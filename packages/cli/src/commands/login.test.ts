import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loginCommand } from "./login.js";

let home: string;
let savedHome: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "glubean-login-test-"));
  savedHome = process.env.HOME;
  process.env.HOME = home;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  // Make the poll loop's sleep resolve immediately (no real 1s waits).
  vi.stubGlobal("setTimeout", ((cb: () => void) => {
    cb();
    return 0 as unknown;
  }) as typeof setTimeout);
});

afterEach(async () => {
  process.env.HOME = savedHome;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true }).catch(() => {});
});

async function readCreds(): Promise<{ token?: string; projectId?: string; authUrl?: string }> {
  const text = await readFile(join(home, ".glubean", "credentials.json"), "utf-8");
  return JSON.parse(text);
}

test("device flow: requests a code, polls, and saves the minted token", async () => {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (url: string) => {
    calls.push(url);
    if (url.endsWith("/cli/device/code")) {
      return new Response(
        JSON.stringify({
          device_code: "dc-secret",
          user_code: "BCDF-GH23",
          verification_uri: "https://api.glubean.test/device",
          verification_uri_complete: "https://api.glubean.test/device?code=BCDF-GH23",
          interval: 1,
          expires_in: 60,
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }
    // /cli/device/token — pending once, then approved.
    const tokenCalls = calls.filter((u) => u.endsWith("/cli/device/token")).length;
    const body =
      tokenCalls < 2
        ? { status: "pending" }
        : { status: "approved", token: "glb_minted_123", projectId: "proj_default_org9" };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);

  // No --project: the grant-bound default project should be persisted.
  await loginCommand({
    authUrl: "https://api.glubean.test",
    noBrowser: true,
  });

  expect(calls[0]).toBe("https://api.glubean.test/cli/device/code");
  expect(calls.some((u) => u.endsWith("/cli/device/token"))).toBe(true);
  const creds = await readCreds();
  expect(creds.token).toBe("glb_minted_123");
  expect(creds.projectId).toBe("proj_default_org9");
  expect(creds.authUrl).toBe("https://api.glubean.test");
});

test("--token escape hatch saves the token without a device flow", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  await loginCommand({
    token: "glb_pasted_xyz",
    project: "proj_2",
    authUrl: "https://api.glubean.test",
  });

  expect(fetchMock).not.toHaveBeenCalled();
  const creds = await readCreds();
  expect(creds.token).toBe("glb_pasted_xyz");
  expect(creds.projectId).toBe("proj_2");
});

test("device flow: a denied grant exits non-zero", async () => {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith("/cli/device/code")) {
      return new Response(
        JSON.stringify({
          device_code: "dc",
          user_code: "BCDF-GH23",
          verification_uri: "https://api.glubean.test/device",
          interval: 1,
          expires_in: 60,
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ status: "denied" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  const exit = vi.spyOn(process, "exit").mockImplementation(((): never => {
    throw new Error("process.exit");
  }) as never);

  await expect(
    loginCommand({ authUrl: "https://api.glubean.test", noBrowser: true }),
  ).rejects.toThrow("process.exit");
  expect(exit).toHaveBeenCalledWith(1);
});
