import { resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { scan } from "@glubean/scanner";
import { buildMetadata } from "../metadata.js";
import { CLI_VERSION } from "../version.js";
import { lintDescription } from "./contracts.js";

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
};

export interface ScanCommandOptions {
  dir?: string;
  output?: string;
}

export async function scanCommand(
  options: ScanCommandOptions = {},
): Promise<void> {
  const dir = options.dir ? resolve(options.dir) : process.cwd();
  const outputPath = options.output ? resolve(options.output) : resolve(dir, "metadata.json");

  console.log(`\n${colors.bold}${colors.blue}🔎 Glubean Scan${colors.reset}\n`);
  console.log(`${colors.dim}Directory: ${dir}${colors.reset}`);
  console.log(`${colors.dim}Output:    ${outputPath}${colors.reset}\n`);

  const scanResult = await scan(dir);
  const hasContracts = (scanResult.contracts ?? []).length > 0;
  if (scanResult.fileCount === 0 && !hasContracts) {
    console.log(`${colors.yellow}⚠️  No test or contract files found.${colors.reset}`);
    console.log(
      `${colors.dim}   Ensure files import @glubean/sdk and export test() or contract.http.with().${colors.reset}\n`,
    );
    process.exit(1);
  }

  // Scanner Phase 4 uses shared extractContractFromFile() for runtime contract
  // extraction. Import errors surface as warnings prefixed with "Contract import failed:".
  const contractImportErrors = scanResult.warnings.filter((w) => w.startsWith("Contract import failed:"));
  const otherWarnings = scanResult.warnings.filter((w) => !w.startsWith("Contract import failed:"));

  if (contractImportErrors.length > 0) {
    console.log(`${colors.yellow}Contract import errors:${colors.reset}`);
    for (const err of contractImportErrors) {
      console.log(`${colors.yellow}  ✗ ${err}${colors.reset}`);
    }
    console.log();
  }

  if (otherWarnings.length > 0) {
    console.log(`${colors.yellow}Warnings:${colors.reset}`);
    for (const warning of otherWarnings) {
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
    existingRaw = await readFile(outputPath, "utf-8");
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

  await writeFile(outputPath, JSON.stringify(metadata, null, 2), "utf-8");
  console.log(`${colors.green}✓ metadata.json updated${colors.reset}`);
  console.log(
    `${colors.dim}  Files: ${metadata.fileCount}, Tests: ${metadata.testCount}${colors.reset}\n`,
  );

  // Description lint for contract cases
  const contracts = scanResult.contracts ?? [];
  const descWarnings: Array<{ contractId: string; caseKey: string; message: string }> = [];
  for (const c of contracts) {
    if (c.description) {
      const w = lintDescription(c.contractId, "(contract)", c.description);
      if (w) descWarnings.push(w);
    }
    for (const cas of c.cases) {
      if (cas.description) {
        const w = lintDescription(c.contractId, cas.key, cas.description);
        if (w) descWarnings.push(w);
      }
    }
  }
  if (descWarnings.length > 0) {
    console.log(`${colors.yellow}⚠ Contract description warnings:${colors.reset}`);
    for (const w of descWarnings) {
      console.log(`${colors.dim}  ${w.contractId}.${w.caseKey}: ${w.message}${colors.reset}`);
    }
    console.log();
  }

  // Hard-fail if any contract files failed to import
  if (contractImportErrors.length > 0) {
    process.exit(1);
  }
}
