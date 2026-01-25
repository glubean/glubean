import { assertEquals } from "@std/assert";
import { join } from "@std/path";

/**
 * Tests for the init command (3-step wizard).
 */

async function createTempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "glubean-init-test-" });
}

async function cleanupDir(dir: string): Promise<void> {
  try {
    await Deno.remove(dir, { recursive: true });
  } catch {
    // Ignore cleanup errors
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function runInitCommand(
  dir: string,
  args: string[] = [],
  stdinText?: string,
  extraEnv?: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const command = new Deno.Command("deno", {
    args: [
      "run",
      "-A",
      join(Deno.cwd(), "packages/cli/mod.ts"),
      "init",
      ...args,
    ],
    cwd: dir,
    // Merge extra env with current env to preserve PATH, HOME, etc.
    env: extraEnv ? { ...Deno.env.toObject(), ...extraEnv } : undefined,
    stdin: stdinText ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
  });

  const child = command.spawn();
  if (stdinText && child.stdin) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(stdinText));
    await writer.close();
  }
  const status = await child.status;
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  return {
    code: status.code,
    stdout,
    stderr,
  };
}

// ---------------------------------------------------------------------------
// Non-interactive tests (--no-interactive)
// ---------------------------------------------------------------------------

Deno.test("init --no-interactive creates basic project files", async () => {
  const dir = await createTempDir();
  try {
    const { code } = await runInitCommand(dir, ["--no-interactive"]);
    assertEquals(code, 0, "init command should succeed");

    // Check that basic files were created
    assertEquals(await fileExists(join(dir, "deno.json")), true);
    assertEquals(await fileExists(join(dir, ".env")), true);
    assertEquals(await fileExists(join(dir, ".env.secrets")), true);
    assertEquals(await fileExists(join(dir, ".gitignore")), true);
    assertEquals(await fileExists(join(dir, "README.md")), true);
    assertEquals(
      await fileExists(join(dir, "context/openapi.sample.json")),
      true,
    );
    assertEquals(await fileExists(join(dir, "demo.test.ts")), true);
    assertEquals(await fileExists(join(dir, "data-driven.test.ts")), true);
    assertEquals(await fileExists(join(dir, "pick.test.ts")), true);
    assertEquals(await fileExists(join(dir, "data/create-user.json")), true);
    assertEquals(await fileExists(join(dir, "AGENTS.md")), true);

    // Verify deno.json content
    const denoJson = JSON.parse(
      await Deno.readTextFile(join(dir, "deno.json")),
    );
    assertEquals(denoJson.imports?.["@glubean/sdk"], "jsr:@glubean/sdk@^0.6.0");
    assertEquals(typeof denoJson.tasks?.scan, "string");
    assertEquals(typeof denoJson.tasks?.["validate-metadata"], "string");

    // Verify .env contains default base URL
    const envContent = await Deno.readTextFile(join(dir, ".env"));
    assertEquals(envContent.includes("https://dummyjson.com"), true);

    // Verify sample test uses builder API and ctx.http
    const testContent = await Deno.readTextFile(join(dir, "demo.test.ts"));
    assertEquals(testContent.includes("ctx.http"), true);
    assertEquals(
      testContent.includes(".step("),
      true,
      "Sample test should demonstrate builder API with .step()",
    );
    assertEquals(
      testContent.includes(".build()"),
      false,
      "Sample test should NOT include .build() (auto-finalized)",
    );
    assertEquals(
      testContent.includes("ctx.trace({"),
      false,
      "Sample test should use ctx.http auto-tracing, not manual ctx.trace() calls",
    );
  } finally {
    await cleanupDir(dir);
  }
});

Deno.test("init --no-interactive --base-url uses custom URL", async () => {
  const dir = await createTempDir();
  try {
    const { code } = await runInitCommand(dir, [
      "--no-interactive",
      "--base-url",
      "https://api.example.com",
    ]);
    assertEquals(code, 0, "init command should succeed");

    // Verify .env contains custom base URL
    const envContent = await Deno.readTextFile(join(dir, ".env"));
    assertEquals(envContent.includes("https://api.example.com"), true);

    // Verify deno.json was created
    assertEquals(await fileExists(join(dir, "deno.json")), true);
  } finally {
    await cleanupDir(dir);
  }
});

Deno.test("init --no-interactive skips existing files", async () => {
  const dir = await createTempDir();
  try {
    // Create a file that already exists
    await Deno.writeTextFile(join(dir, "deno.json"), '{"existing": true}');

    const { code, stdout } = await runInitCommand(dir, ["--no-interactive"]);
    assertEquals(code, 0, "init command should succeed");

    // Verify the existing file was not overwritten
    const content = await Deno.readTextFile(join(dir, "deno.json"));
    assertEquals(content, '{"existing": true}');

    // Verify stdout mentions skipping
    assertEquals(stdout.includes("skip"), true);
  } finally {
    await cleanupDir(dir);
  }
});

Deno.test(
  "init --no-interactive --overwrite replaces existing files",
  async () => {
    const dir = await createTempDir();
    try {
      await Deno.writeTextFile(join(dir, "deno.json"), '{"existing": true}');

      const { code, stdout } = await runInitCommand(dir, [
        "--overwrite",
        "--no-interactive",
      ]);
      assertEquals(code, 0, "init command should succeed");

      const content = await Deno.readTextFile(join(dir, "deno.json"));
      assertEquals(content.includes('"imports"'), true);
      assertEquals(stdout.includes("overwrite"), true);
    } finally {
      await cleanupDir(dir);
    }
  },
);

Deno.test(
  "init --no-interactive --github-actions creates workflow file",
  async () => {
    const dir = await createTempDir();
    try {
      const { code } = await runInitCommand(dir, [
        "--github-actions",
        "--no-interactive",
      ]);
      assertEquals(code, 0, "init command should succeed");

      const workflowPath = join(dir, ".github/workflows/glubean-metadata.yml");
      assertEquals(await fileExists(workflowPath), true);

      const content = await Deno.readTextFile(workflowPath);
      assertEquals(content.includes("Glubean Metadata"), true);
      assertEquals(content.includes("glubean/cli scan"), true);
    } finally {
      await cleanupDir(dir);
    }
  },
);

Deno.test(
  "init --no-interactive --hooks creates git hooks when .git exists",
  async () => {
    const dir = await createTempDir();
    try {
      // Create .git directory to simulate git repo
      await Deno.mkdir(join(dir, ".git/hooks"), { recursive: true });

      const { code } = await runInitCommand(dir, [
        "--hooks",
        "--no-interactive",
      ]);
      assertEquals(code, 0, "init command should succeed");

      assertEquals(await fileExists(join(dir, ".git/hooks/pre-commit")), true);
      assertEquals(await fileExists(join(dir, ".git/hooks/pre-push")), true);

      const preCommit = await Deno.readTextFile(
        join(dir, ".git/hooks/pre-commit"),
      );
      assertEquals(preCommit.includes("glubean/cli scan"), true);

      const prePush = await Deno.readTextFile(join(dir, ".git/hooks/pre-push"));
      assertEquals(prePush.includes("validate-metadata"), true);
    } finally {
      await cleanupDir(dir);
    }
  },
);

Deno.test(
  "init --no-interactive --hooks fails when no .git directory",
  async () => {
    const dir = await createTempDir();
    try {
      const { code, stderr } = await runInitCommand(dir, [
        "--hooks",
        "--no-interactive",
      ]);
      assertEquals(code, 1, "init command should fail without .git");

      // No files should be created (exit before file creation)
      assertEquals(await fileExists(join(dir, "deno.json")), false);

      // Should mention git init
      assertEquals(stderr.includes("git init"), true);
    } finally {
      await cleanupDir(dir);
    }
  },
);

Deno.test(
  "init --no-interactive --hooks --github-actions creates both",
  async () => {
    const dir = await createTempDir();
    try {
      await Deno.mkdir(join(dir, ".git/hooks"), { recursive: true });

      const { code } = await runInitCommand(dir, [
        "--hooks",
        "--github-actions",
        "--no-interactive",
      ]);
      assertEquals(code, 0, "init command should succeed");

      assertEquals(await fileExists(join(dir, ".git/hooks/pre-commit")), true);
      assertEquals(await fileExists(join(dir, ".git/hooks/pre-push")), true);
      assertEquals(
        await fileExists(join(dir, ".github/workflows/glubean-metadata.yml")),
        true,
      );
    } finally {
      await cleanupDir(dir);
    }
  },
);

// ---------------------------------------------------------------------------
// Interactive tests (GLUBEAN_FORCE_INTERACTIVE=1 + piped stdin)
// ---------------------------------------------------------------------------

Deno.test(
  "init interactive - defaults create project with hooks and actions",
  async () => {
    const dir = await createTempDir();
    try {
      await Deno.mkdir(join(dir, ".git/hooks"), { recursive: true });

      // Step 1: Enter (default = Standard)
      // Step 2: Enter (default base URL)
      // Step 3: .git detected → hooks Y/n (Enter=Y) → actions Y/n (Enter=Y)
      const { code } = await runInitCommand(dir, [], "\n\n\n\n", {
        GLUBEAN_FORCE_INTERACTIVE: "1",
      });
      assertEquals(code, 0, "init command should succeed");

      assertEquals(await fileExists(join(dir, "deno.json")), true);
      assertEquals(await fileExists(join(dir, "demo.test.ts")), true);
      assertEquals(await fileExists(join(dir, ".git/hooks/pre-commit")), true);
      assertEquals(await fileExists(join(dir, ".git/hooks/pre-push")), true);
      assertEquals(
        await fileExists(join(dir, ".github/workflows/glubean-metadata.yml")),
        true,
      );
    } finally {
      await cleanupDir(dir);
    }
  },
);

Deno.test("init interactive - no .git offers to init git", async () => {
  const dir = await createTempDir();
  try {
    // Step 1: Enter (default = Standard)
    // Step 2: Enter (default base URL)
    // Step 3: no .git → init git? Y (Enter=Y) → hooks Y/n (Enter=Y) → actions Y/n (Enter=Y)
    const { code, stdout } = await runInitCommand(dir, [], "\n\n\n\n\n", {
      GLUBEAN_FORCE_INTERACTIVE: "1",
    });
    assertEquals(code, 0, "init command should succeed");

    // Git should have been initialized
    assertEquals(await fileExists(join(dir, ".git")), true);
    assertEquals(stdout.includes("Git repository initialized"), true);

    // Hooks should be created
    assertEquals(await fileExists(join(dir, ".git/hooks/pre-commit")), true);
    assertEquals(await fileExists(join(dir, ".git/hooks/pre-push")), true);
  } finally {
    await cleanupDir(dir);
  }
});

Deno.test("init interactive - decline git init skips hooks", async () => {
  const dir = await createTempDir();
  try {
    // Step 1: Enter (default = Standard)
    // Step 2: Enter (default base URL)
    // Step 3: no .git → init git? n
    const { code, stdout } = await runInitCommand(dir, [], "\n\nn\n", {
      GLUBEAN_FORCE_INTERACTIVE: "1",
    });
    assertEquals(code, 0, "init command should succeed");

    // Basic files should still be created
    assertEquals(await fileExists(join(dir, "deno.json")), true);
    assertEquals(await fileExists(join(dir, "demo.test.ts")), true);

    // No git, no hooks
    assertEquals(await fileExists(join(dir, ".git")), false);
    assertEquals(stdout.includes("Skipping Git hooks"), true);
  } finally {
    await cleanupDir(dir);
  }
});

Deno.test("init --playground creates playground files", async () => {
  const dir = await createTempDir();
  try {
    const { code } = await runInitCommand(dir, [
      "--playground",
      "--no-interactive",
    ]);
    assertEquals(code, 0, "init command should succeed");

    assertEquals(await fileExists(join(dir, "deno.json")), true);
    assertEquals(await fileExists(join(dir, ".env")), true);
    assertEquals(await fileExists(join(dir, "smoke.test.ts")), true);
    assertEquals(await fileExists(join(dir, "README.md")), true);
    assertEquals(await fileExists(join(dir, "AGENTS.md")), true);

    // Playground should not create standard test file
    assertEquals(await fileExists(join(dir, "api.test.ts")), false);

    // Verify playground content
    const envContent = await Deno.readTextFile(join(dir, ".env"));
    assertEquals(envContent.includes("dummyjson.com"), true);
  } finally {
    await cleanupDir(dir);
  }
});

Deno.test("init interactive - choose playground", async () => {
  const dir = await createTempDir();
  try {
    // Step 1: "2" (Playground)
    const { code } = await runInitCommand(dir, [], "2\n", {
      GLUBEAN_FORCE_INTERACTIVE: "1",
    });
    assertEquals(code, 0, "init command should succeed");

    // Playground files
    assertEquals(await fileExists(join(dir, "smoke.test.ts")), true);
    assertEquals(await fileExists(join(dir, "api.test.ts")), false);

    const envContent = await Deno.readTextFile(join(dir, ".env"));
    assertEquals(envContent.includes("dummyjson.com"), true);
  } finally {
    await cleanupDir(dir);
  }
});
