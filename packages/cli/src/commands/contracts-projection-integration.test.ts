/**
 * Command-level integration test for `glubean contracts --projection <name>`
 * (GLU-117): declarative `projections.contracts` in glubean.yaml, resolved
 * and generated end-to-end via `contractsCommand`, replacing the ad-hoc
 * `--dir/--format/--title` + shell-redirection commands dogfood used to run
 * one at a time for merged / dashboard-only / platform-only OpenAPI output.
 *
 * Mirrors the dogfood shape: two surfaces (dashboard, platform) each with
 * their own `.contract.ts` file under a shared `contracts/` root, projected
 * to a merged OpenAPI doc plus two surface-scoped OpenAPI docs.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { __resetInstalledPluginsForTesting } from "@glubean/sdk/internal";
import { contractsCommand } from "./contracts.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(HERE, "..", "..", ".tmp-contracts-projection-integration");
let fixtureSeq = 0;
let fixtureDir: string;
let originalCwd: string;

beforeEach(async () => {
  fixtureSeq += 1;
  fixtureDir = join(FIXTURE_ROOT, String(fixtureSeq));
  await mkdir(fixtureDir, { recursive: true });
  __resetInstalledPluginsForTesting();
  originalCwd = process.cwd();
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(fixtureDir, { recursive: true, force: true });
});

afterAll(async () => {
  await rm(FIXTURE_ROOT, { recursive: true, force: true });
});

const MOCK_CLIENT = `
const mockClient: any = {
  get: () => ({ json: async () => ({}) }),
  post: () => ({ json: async () => ({}) }),
  put: () => ({ json: async () => ({}) }),
  delete: () => ({ json: async () => ({}) }),
  head: () => ({ json: async () => ({}) }),
  patch: () => ({ json: async () => ({}) }),
};
`;

async function writeSurfaceContract(surface: "dashboard" | "platform"): Promise<void> {
  const dir = join(fixtureDir, "contracts", surface);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "health.contract.ts"),
    `
import { contract } from "@glubean/sdk";
${MOCK_CLIENT}
const api = contract.http.with("${surface}", { client: mockClient });

export const health = api("${surface}-health", {
  endpoint: "GET /${surface}/health",
  description: "Check service availability",
  feature: "Health",
  cases: {
    healthy: { description: "service reports healthy", expect: { status: 200 } },
  },
});
`,
  );
}

async function writeGlubeanYaml(): Promise<void> {
  await writeFile(
    join(fixtureDir, "glubean.yaml"),
    `
version: 1
suites:
  contracts:
    target: ./contracts
    kinds: [contract, flow]
profiles:
  local:
    suites: [contracts]
projections:
  contracts:
    merged-openapi:
      suite: contracts
      format: openapi
      title: Merged Contracts
      output: reports/projections/openapi.json
    dashboard-openapi:
      target: contracts/dashboard
      format: openapi
      title: Dashboard Contracts
      output: reports/projections/dashboard.openapi.json
    platform-openapi:
      target: contracts/platform
      format: openapi
      title: Platform Contracts
      output: reports/projections/platform.openapi.json
`,
  );
}

describe("glubean contracts --projection (end-to-end, GLU-117)", () => {
  test("--projection all generates every declared output to its configured path", async () => {
    await writeSurfaceContract("dashboard");
    await writeSurfaceContract("platform");
    await writeGlubeanYaml();
    process.chdir(fixtureDir);

    await contractsCommand({ projection: "all" });

    const merged = JSON.parse(
      await readFile(join(fixtureDir, "reports/projections/openapi.json"), "utf-8"),
    );
    const dashboard = JSON.parse(
      await readFile(join(fixtureDir, "reports/projections/dashboard.openapi.json"), "utf-8"),
    );
    const platform = JSON.parse(
      await readFile(join(fixtureDir, "reports/projections/platform.openapi.json"), "utf-8"),
    );

    expect(merged.info.title).toBe("Merged Contracts");
    expect(dashboard.info.title).toBe("Dashboard Contracts");
    expect(platform.info.title).toBe("Platform Contracts");

    // Surface-scoped projections only see their own surface's operation.
    expect(Object.keys(dashboard.paths)).toEqual(["/dashboard/health"]);
    expect(Object.keys(platform.paths)).toEqual(["/platform/health"]);
  });

  test("--projection <name> generates a single declared output", async () => {
    await writeSurfaceContract("dashboard");
    await writeGlubeanYaml();
    process.chdir(fixtureDir);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await contractsCommand({ projection: "dashboard-openapi" });

    const dashboard = JSON.parse(
      await readFile(join(fixtureDir, "reports/projections/dashboard.openapi.json"), "utf-8"),
    );
    expect(dashboard.info.title).toBe("Dashboard Contracts");
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("dashboard-openapi"),
    );
    logSpy.mockRestore();
  });

  test("unknown --projection name exits 1 and lists available names", async () => {
    await writeSurfaceContract("dashboard");
    await writeGlubeanYaml();
    process.chdir(fixtureDir);

    const exit = vi.spyOn(process, "exit").mockImplementation(((): never => {
      throw new Error("process.exit");
    }) as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(contractsCommand({ projection: "does-not-exist" })).rejects.toThrow(
        "process.exit",
      );
      expect(errSpy.mock.calls.flat().join("\n")).toContain(
        'Contract projection "does-not-exist" not found',
      );
    } finally {
      exit.mockRestore();
      errSpy.mockRestore();
    }
  });

  test("--projection all with no declared projections exits 1", async () => {
    await writeSurfaceContract("dashboard");
    await writeFile(
      join(fixtureDir, "glubean.yaml"),
      `
version: 1
suites:
  contracts: { target: ./contracts, kinds: [contract, flow] }
profiles:
  local: { suites: [contracts] }
`,
    );
    process.chdir(fixtureDir);

    const exit = vi.spyOn(process, "exit").mockImplementation(((): never => {
      throw new Error("process.exit");
    }) as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(contractsCommand({ projection: "all" })).rejects.toThrow("process.exit");
      expect(errSpy.mock.calls.flat().join("\n")).toContain(
        "No contract projections declared",
      );
    } finally {
      exit.mockRestore();
      errSpy.mockRestore();
    }
  });

  test("existing --dir/--format/--title flags still work without a glubean.yaml (back-compat)", async () => {
    await writeSurfaceContract("dashboard");
    process.chdir(fixtureDir);

    const chunks: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((buf: unknown) => {
        chunks.push(typeof buf === "string" ? buf : String(buf));
        return true;
      });
    try {
      await contractsCommand({
        dir: "contracts/dashboard",
        format: "openapi",
        title: "Direct Flag Contracts",
      });
    } finally {
      stdoutSpy.mockRestore();
    }

    const spec = JSON.parse(chunks.join(""));
    expect(spec.info.title).toBe("Direct Flag Contracts");
    expect(Object.keys(spec.paths)).toEqual(["/dashboard/health"]);
  });
});
