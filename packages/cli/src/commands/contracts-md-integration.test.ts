/**
 * Command-level integration test for `glubean contracts --format md-outline`.
 *
 * Closes the gap flagged in the CAR-1/2/3 RFR: the existing
 * `formatMdOutline(ContractStaticMeta[])` unit tests only exercise the
 * shimmed contract-document formatter, not the real CLI command path,
 * which now routes contracts through `renderArtifact(markdownArtifact,
 * result.contracts)` and still appends flows via `formatFlowsMdSection`
 * (D15 — flow rendering stays CLI-side).
 *
 * This test invokes `contractsCommand` against real fixture projects
 * (contracts-only / flows-only / mixed) and captures stdout. Asserts
 * structure end-to-end:
 *   - contracts section emitted via artifact registry
 *   - flows section emitted via CLI legacy path
 *   - trimEnd + "\n\n" separator between the two (matches pre-CAR-2
 *     byte layout)
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
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
const FIXTURE_ROOT = join(HERE, "..", "..", ".tmp-contracts-md-integration");
let fixtureSeq = 0;
let fixtureDir: string;

beforeEach(async () => {
  fixtureSeq += 1;
  fixtureDir = join(FIXTURE_ROOT, String(fixtureSeq));
  await mkdir(fixtureDir, { recursive: true });
  __resetInstalledPluginsForTesting();
});

afterEach(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

afterAll(async () => {
  await rm(FIXTURE_ROOT, { recursive: true, force: true });
});

/** Capture what `contractsCommand` writes to stdout. */
async function captureMd(dir: string): Promise<string> {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((buf: unknown) => {
      chunks.push(typeof buf === "string" ? buf : String(buf));
      return true;
    });
  try {
    await contractsCommand({ dir, format: "md-outline" });
  } finally {
    spy.mockRestore();
  }
  return chunks.join("");
}

async function writeHttpContract(): Promise<void> {
  const contractsDir = join(fixtureDir, "contracts");
  await mkdir(contractsDir, { recursive: true });
  await writeFile(
    join(contractsDir, "users.contract.ts"),
    `
import { contract } from "@glubean/sdk";

const mockClient: any = {
  get: () => ({ json: async () => ({}) }),
  post: () => ({ json: async () => ({}) }),
  put: () => ({ json: async () => ({}) }),
  delete: () => ({ json: async () => ({}) }),
  head: () => ({ json: async () => ({}) }),
  patch: () => ({ json: async () => ({}) }),
};
const api = contract.http.with("users-api", { client: mockClient });

export const getUser = api("get-user", {
  endpoint: "GET /users/:id",
  description: "Fetch a user by id",
  feature: "Users",
  cases: {
    ok: { description: "happy path", expect: { status: 200 } },
    notFound: { description: "missing id", expect: { status: 404 } },
  },
});
`,
  );
}

async function writeFlow(): Promise<void> {
  const flowsDir = join(fixtureDir, "flows");
  await mkdir(flowsDir, { recursive: true });
  await writeFile(
    join(flowsDir, "signup.flow.ts"),
    `
import { contract } from "@glubean/sdk";

export const signup = contract
  .flow("signup-flow")
  .meta({ description: "User signup end-to-end" })
  .setup(async () => ({}));
`,
  );
}

describe("glubean contracts --format md-outline (end-to-end)", () => {
  test("contracts-only: output is renderArtifact(markdownArtifact, ...) with no flows section", async () => {
    await writeHttpContract();
    const md = await captureMd(fixtureDir);

    // assembleMarkdownDocument header
    expect(md).toContain("# Contract Specification");
    // Summary line pattern (date + "N cases" + breakdowns)
    expect(md).toMatch(/Generated: \d{4}-\d{2}-\d{2} \| 2 cases \| 2 active/);
    // Feature heading — hasInstances pre-pass produces `${instance}: ${feature}`
    // when any contract uses contract.http.with("<instance>", ...).
    expect(md).toContain("## users-api: Users");
    // Per-case output format from assembleMarkdownDocument
    expect(md).toContain("- **ok** — happy path");
    expect(md).toContain("- **notFound** — missing id");
    // Contract description intro
    expect(md).toContain("Fetch a user by id");
    // No flows section
    expect(md).not.toContain("## Flows");
    // Ends with a single trailing newline (assembleMarkdownDocument invariant)
    expect(md.endsWith("\n")).toBe(true);
  });

  test("flows-only: contracts block is the minimal placeholder + flows section", async () => {
    await writeFlow();
    const md = await captureMd(fixtureDir);

    // Placeholder doc header (CLI fallback path when contracts is empty)
    expect(md).toContain("# Contract Specification");
    expect(md).toMatch(/Generated: \d{4}-\d{2}-\d{2} \| 1 flow\(s\)/);
    // Flows section — comes from CLI's formatFlowsMdSection (legacy path)
    expect(md).toContain("## Flows");
    expect(md).toContain("### signup-flow");
    expect(md).toContain("User signup end-to-end");
    // No Users-style feature heading (no contracts)
    expect(md).not.toContain("## Users");
  });

  test("mixed: contracts section then flows section with blank-line separator", async () => {
    await writeHttpContract();
    await writeFlow();
    const md = await captureMd(fixtureDir);

    // Both sections present
    expect(md).toContain("## users-api: Users");
    expect(md).toContain("## Flows");
    expect(md).toContain("### signup-flow");

    // Order: contracts come before flows
    const usersIdx = md.indexOf("## users-api: Users");
    const flowsIdx = md.indexOf("## Flows");
    expect(usersIdx).toBeGreaterThan(-1);
    expect(flowsIdx).toBeGreaterThan(-1);
    expect(usersIdx).toBeLessThan(flowsIdx);

    // Separator invariant: contracts block trimEnd() + "\n\n" + flows
    // (see contractsCommand implementation in contracts.ts). The slice
    // between the two headings is the contracts section body + exactly
    // one blank line separator (== ends with "\n\n", not "\n\n\n").
    const joint = md.slice(usersIdx, flowsIdx);
    expect(joint.endsWith("\n\n")).toBe(true);
    expect(joint.endsWith("\n\n\n")).toBe(false);
  });
});
