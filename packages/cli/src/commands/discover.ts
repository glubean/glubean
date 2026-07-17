import { resolve } from "node:path";

import {
  buildProjectCatalog,
  catalogHasBlockingIssues,
  serializeCatalog,
  writeCatalog,
  type CatalogDiagnostic,
  type ProjectCatalog,
} from "../lib/catalog.js";

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

export interface DiscoverCommandOptions {
  dir?: string;
  out?: string;
  format?: string;
  filters?: string[];
  offline?: boolean;
  strict?: boolean;
}

function resolveFormat(value: string | undefined, output: string | undefined): "yaml" | "json" {
  const format = value?.toLowerCase() ?? (output?.toLowerCase().endsWith(".json") ? "json" : "yaml");
  if (format === "yml") return "yaml";
  if (format !== "yaml" && format !== "json") {
    throw new Error(`Unknown catalog format "${value}". Use yaml or json.`);
  }
  return format;
}

function statusMark(status: "ready" | "blocked" | "unverified"): string {
  if (status === "ready") return `${colors.green}ready${colors.reset}`;
  if (status === "blocked") return `${colors.red}blocked${colors.reset}`;
  return `${colors.yellow}unverified${colors.reset}`;
}

function diagnosticMark(item: CatalogDiagnostic): string {
  if (item.severity === "error") return `${colors.red}error${colors.reset}`;
  if (item.severity === "warning") return `${colors.yellow}warn ${colors.reset}`;
  return `${colors.cyan}info ${colors.reset}`;
}

function printInventory(catalog: ProjectCatalog): void {
  const summary = catalog.summary;
  console.log(`\n${colors.bold}Glubean project catalog${colors.reset}`);
  console.log(
    `  ${summary.files} files  ·  ${summary.tests} tests  ·  ${summary.contracts} contracts (${summary.contractCases} cases)` +
      `  ·  ${summary.workflows} workflows  ·  ${summary.loadPlans} load plans  ·  ${summary.openapiPaths} OpenAPI paths`,
  );
}

function printEnvironments(catalog: ProjectCatalog): void {
  console.log(`\n${colors.bold}Environments${colors.reset}`);
  for (const environment of catalog.environments) {
    const active = environment.active ? ` ${colors.cyan}(active)${colors.reset}` : "";
    console.log(`  ${environment.name}${active}  sync ${statusMark(environment.sync.status)}  upload ${statusMark(environment.upload.status)}`);
    const details = [
      environment.projectId ? `project ${environment.projectId}` : undefined,
      environment.targetId ? `target ${environment.targetId}` : undefined,
      environment.tokenPresent ? "token present" : "token missing",
      environment.cloudCheck !== "not-run" ? `cloud ${environment.cloudCheck}` : undefined,
    ].filter(Boolean);
    console.log(`    ${colors.dim}${environment.file}${details.length ? ` · ${details.join(" · ")}` : ""}${colors.reset}`);
    if (environment.url) console.log(`    ${colors.cyan}${environment.url}${colors.reset}`);
  }
}

function printDiagnostics(catalog: ProjectCatalog, all: boolean): void {
  const diagnostics = all
    ? catalog.diagnostics
    : catalog.diagnostics.filter((item) => item.severity !== "info");
  if (diagnostics.length === 0) {
    console.log(`\n${colors.green}✓ No issues found.${colors.reset}`);
    return;
  }
  console.log(`\n${colors.bold}Diagnostics${colors.reset} ${colors.dim}(${catalog.summary.errors} errors, ${catalog.summary.warnings} warnings)${colors.reset}`);
  for (const item of diagnostics) {
    const scope = item.file ?? (item.environment ? `env:${item.environment}` : item.assetId);
    console.log(`  ${diagnosticMark(item)}  ${scope ? `${scope}: ` : ""}${item.message} ${colors.dim}[${item.code}]${colors.reset}`);
    if (item.remediation) console.log(`         ${colors.dim}${item.remediation}${colors.reset}`);
  }
}

export async function discoverCommand(options: DiscoverCommandOptions = {}): Promise<number> {
  const { rootDir, catalog } = await buildProjectCatalog({
    dir: options.dir,
    offline: options.offline,
    filters: options.filters,
  });
  const output = options.out ?? resolve(rootDir, "catalog.yml");
  const format = resolveFormat(options.format, output);
  if (output === "-") {
    process.stdout.write(serializeCatalog(catalog, format));
  } else {
    const outputPath = resolve(process.cwd(), output);
    await writeCatalog(outputPath, catalog, format);
    printInventory(catalog);
    printEnvironments(catalog);
    printDiagnostics(catalog, false);
    console.log(`\n${colors.green}✓ Catalog written:${colors.reset} ${outputPath}`);
  }
  return options.strict && catalogHasBlockingIssues(catalog) ? 1 : 0;
}

export async function doctorCommand(options: DiscoverCommandOptions = {}): Promise<number> {
  const { catalog } = await buildProjectCatalog({
    dir: options.dir,
    offline: options.offline,
    filters: options.filters,
  });
  printInventory(catalog);
  printEnvironments(catalog);
  printDiagnostics(catalog, true);
  if (options.out) {
    const format = resolveFormat(options.format, options.out);
    const outputPath = resolve(process.cwd(), options.out);
    await writeCatalog(outputPath, catalog, format);
    console.log(`\n${colors.green}✓ Diagnostic catalog written:${colors.reset} ${outputPath}`);
  }
  return catalogHasBlockingIssues(catalog) ? 1 : 0;
}
