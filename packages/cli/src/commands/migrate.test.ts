import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { migrateCommand } from "./migrate.js";

async function createTempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "glubean-migrate-test-"));
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write;
  const originalLog = console.log;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf-8"));
    return true;
  }) as typeof process.stdout.write;
  console.log = (...args: unknown[]) => {
    chunks.push(`${args.map(String).join(" ")}\n`);
  };
  try {
    await fn();
  } finally {
    console.log = originalLog;
    process.stdout.write = originalWrite;
  }
  return chunks.join("").replace(/\x1b\[[0-9;]*m/g, "");
}

test("migrate dry-run previews legacy contract and plugin changes without writing", async () => {
  const dir = await createTempDir();
  const contractPath = join(dir, "users.contract.ts");
  const original = `import { contract } from "@glubean/sdk";
import "@glubean/graphql";

export const createUser = contract.http("create-user", {
  endpoint: "POST /users",
  cases: {
    ok: {
      description: "created",
      needs: UserInput,
      setup: async () => ({}),
      expect: { status: 201 },
    },
  },
});
`;

  try {
    await writeFile(contractPath, original, "utf-8");

    const stdout = await captureStdout(() => migrateCommand({ dir }));

    expect(stdout).toContain("Mode: dry-run");
    expect(stdout).toContain('Rewrite contract.http("id", spec)');
    expect(stdout).toContain("Move @glubean/graphql side-effect plugin import");
    expect(stdout).toContain("Case-level setup was removed");
    expect(stdout).toContain("defineHttpCase<Needs>");
    expect(stdout).toContain("+++ glubean.setup.ts");

    await expect(readFile(contractPath, "utf-8")).resolves.toBe(original);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("migrate --apply rewrites safe legacy patterns and creates glubean.setup.ts", async () => {
  const dir = await createTempDir();
  const contractPath = join(dir, "billing.contract.ts");

  try {
    await writeFile(
      contractPath,
      `import { contract } from "@glubean/sdk";
import "@glubean/grpc";

export const invoice = contract.http("invoice", {
  endpoint: "GET /invoice",
  cases: {
    ok: {
      description: "read invoice",
      expect: { status: 200 },
    },
  },
});
`,
      "utf-8",
    );

    const stdout = await captureStdout(() => migrateCommand({ dir, apply: true }));

    expect(stdout).toContain("Mode: apply");
    expect(stdout).toContain("Applied 2 file(s).");

    const contract = await readFile(contractPath, "utf-8");
    expect(contract).not.toContain('import "@glubean/grpc"');
    expect(contract).toContain('const migratedHttp = contract.http.with("billing", {});');
    expect(contract).toContain('export const invoice = migratedHttp("invoice", {');

    const setup = await readFile(join(dir, "glubean.setup.ts"), "utf-8");
    expect(setup).toContain('import { installPlugin } from "@glubean/sdk";');
    expect(setup).toContain('import grpcPlugin from "@glubean/grpc";');
    expect(setup).toContain("await installPlugin(grpcPlugin);");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("migrate reports legacy definePlugin factories for manual review", async () => {
  const dir = await createTempDir();

  try {
    await writeFile(
      join(dir, "legacy-plugin.ts"),
      `import { definePlugin } from "@glubean/sdk";

export const plugin = definePlugin((runtime) => ({
  http: runtime.http,
}));
`,
      "utf-8",
    );

    const stdout = await captureStdout(() => migrateCommand({ dir }));

    expect(stdout).toContain("Manual review");
    expect(stdout).toContain("definePlugin((runtime) => ...) was removed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
