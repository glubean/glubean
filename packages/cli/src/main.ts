import { parseArgs } from "node:util";
import { resolve, relative } from "node:path";
import { readdir, stat } from "node:fs/promises";
import { TestExecutor, resolveModuleTests } from "@glubean/runner";

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    filter: { type: "string", short: "f" },
    verbose: { type: "boolean", short: "v", default: false },
    timeout: { type: "string", short: "t" },
  },
  allowPositionals: true,
  strict: false,
});

const command = positionals[0];

if (!command || command === "help") {
  console.log(`
  gb - Glubean CLI (Node.js)

  Usage:
    gb run [file|dir]       Run tests
    gb run . --filter id    Run a specific test

  Options:
    -f, --filter <id>       Run only tests matching this ID
    -v, --verbose           Show detailed output
    -t, --timeout <ms>      Per-test timeout (default: 30000)
`);
  process.exit(0);
}

if (command === "run") {
  const target = positionals[1] || ".";
  const filterTestId = values.filter as string | undefined;
  const verbose = values.verbose as boolean;
  const timeout = values.timeout ? parseInt(values.timeout as string, 10) : 30000;

  // Resolve test files
  const testFiles = await resolveTestFiles(resolve(process.cwd(), target));

  if (testFiles.length === 0) {
    console.log("No test files found.");
    process.exit(1);
  }

  const executor = new TestExecutor({
    cwd: process.cwd(),
  });

  let totalTests = 0;
  let totalPassed = 0;
  let totalFailed = 0;
  const startTime = Date.now();

  for (const file of testFiles) {
    const relPath = relative(process.cwd(), file);

    // Discover tests in the file
    const mod = await import(file);
    const tests = resolveModuleTests(mod);

    if (tests.length === 0) continue;

    // Filter if needed
    const toRun = filterTestId
      ? tests.filter((t) => t.id === filterTestId || t.id.includes(filterTestId))
      : tests;

    if (toRun.length === 0) continue;

    console.log(`\n  ${relPath}`);

    for (const test of toRun) {
      totalTests++;
      const result = await executor.execute(file, test.id, {
        vars: {},
        secrets: {},
        test: { id: test.id, tags: test.tags ?? [] },
      }, { timeout });

      if (result.success) {
        totalPassed++;
        console.log(`    ✓ ${test.name || test.id}  (${result.duration}ms)`);
      } else {
        totalFailed++;
        console.log(`    ✗ ${test.name || test.id}  (${result.duration}ms)`);
        if (result.error) {
          console.log(`      ${result.error}`);
        }
      }

      if (verbose) {
        for (const event of result.events) {
          if (event.type === "assertion") {
            const mark = event.passed ? "✓" : "✗";
            console.log(`      ${mark} ${event.message}`);
          } else if (event.type === "log") {
            console.log(`      ℹ ${event.message}`);
          }
        }
      }
    }
  }

  const duration = Date.now() - startTime;
  console.log(`\n  ${totalPassed} passed, ${totalFailed} failed (${totalTests} total) — ${duration}ms\n`);
  process.exit(totalFailed > 0 ? 1 : 0);
} else {
  console.log(`Unknown command: ${command}`);
  console.log(`Run "gb help" for usage.`);
  process.exit(1);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function resolveTestFiles(target: string): Promise<string[]> {
  const s = await stat(target);
  if (s.isFile()) {
    return isTestFile(target) ? [target] : [];
  }

  if (s.isDirectory()) {
    const files: string[] = [];
    await walkForTests(target, files);
    return files.sort();
  }

  return [];
}

async function walkForTests(dir: string, result: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = resolve(dir, entry.name);
    if (entry.isFile() && isTestFile(entry.name)) {
      result.push(full);
    } else if (entry.isDirectory()) {
      await walkForTests(full, result);
    }
  }
}

function isTestFile(name: string): boolean {
  return /\.(test|spec)\.(ts|mts|js|mjs)$/.test(name);
}
