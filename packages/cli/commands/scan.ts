import { resolve } from "@std/path";
import { scan } from "@glubean/scanner";
import { buildMetadata } from "../metadata.ts";
import { CLI_VERSION } from "../version.ts";

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
};

export interface ScanCommandOptions {
  /** Directory to scan (default: current directory) */
  dir?: string;
  /** Output metadata path (default: <dir>/metadata.json) */
  output?: string;
}

export async function scanCommand(
  options: ScanCommandOptions = {},
): Promise<void> {
  const dir = options.dir ? resolve(options.dir) : Deno.cwd();
  const outputPath = options.output ? resolve(options.output) : resolve(dir, "metadata.json");

  console.log(`\n${colors.bold}${colors.blue}🔎 Glubean Scan${colors.reset}\n`);
  console.log(`${colors.dim}Directory: ${dir}${colors.reset}`);
  console.log(`${colors.dim}Output:    ${outputPath}${colors.reset}\n`);

  const scanResult = await scan(dir);
  if (scanResult.fileCount === 0) {
    console.log(`${colors.yellow}⚠️  No test files found.${colors.reset}`);
    console.log(
      `${colors.dim}   Ensure test files import @glubean/sdk and export test().${colors.reset}\n`,
    );
    Deno.exit(1);
  }

  if (scanResult.warnings.length > 0) {
    console.log(`${colors.yellow}Warnings:${colors.reset}`);
    for (const warning of scanResult.warnings) {
      console.log(`${colors.dim}- ${warning}${colors.reset}`);
    }
    console.log();
  }

  const metadata = await buildMetadata(scanResult, {
    generatedBy: `@glubean/cli@${CLI_VERSION}`,
  });

  let existing: Record<string, unknown> | null = null;
  let existingRaw: string | null = null;
  try {
    existingRaw = await Deno.readTextFile(outputPath);
    existing = JSON.parse(existingRaw) as Record<string, unknown>;
  } catch {
    existing = null;
    existingRaw = null;
  }

  if (existing && existingRaw) {
    const normalizedExisting = existingRaw
      .replace(/"generatedAt"\s*:\s*"[^"]*"/, '"generatedAt": "__KEEP__"')
      .trimEnd();
    const normalizedNext = JSON.stringify(
      { ...metadata, generatedAt: "__KEEP__" },
      null,
      2,
    ).trimEnd();
    if (normalizedExisting === normalizedNext) {
      const generatedAt = existing.generatedAt;
      if (typeof generatedAt === "string") {
        metadata.generatedAt = generatedAt;
      }
    }
  }

  await Deno.writeTextFile(outputPath, JSON.stringify(metadata, null, 2));
  console.log(`${colors.green}✓ metadata.json updated${colors.reset}`);
  console.log(
    `${colors.dim}  Files: ${metadata.fileCount}, Tests: ${metadata.testCount}${colors.reset}\n`,
  );
}
