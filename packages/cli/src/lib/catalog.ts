import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { loadProjectEnv } from "@glubean/runner";
import {
  classifyByStem,
  extractLoadPlansFromFile,
  type GlubeanFileKind,
} from "@glubean/scanner";

import {
  buildProjections,
  type ProjectedContract,
  type ProjectedTest,
  type ProjectedWorkflow,
  type ProjectionResult,
} from "../commands/dry-run.js";
import { findProjectConfig } from "../commands/run.js";
import {
  checkTargetInProject,
  checkUploadAuth,
  resolveApiUrl,
  resolveProjectId,
  resolveTargetId,
  resolveToken,
} from "./auth.js";
import { readActiveEnv } from "./active_env.js";
import { CLI_VERSION } from "../version.js";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);
const TEMPLATE_ENV_PARTS = new Set(["example", "sample", "template"]);

export type CatalogAssetKind = "test" | "contract" | "workflow" | "openapi" | "load";
export type CatalogFileKind = CatalogAssetKind | "bootstrap" | "setup" | "session" | "config";
export type CatalogSeverity = "error" | "warning" | "info";
export type ReadinessStatus = "ready" | "blocked" | "unverified";

export interface CatalogDiagnostic {
  severity: CatalogSeverity;
  code: string;
  message: string;
  blocksSync?: boolean;
  blocksUpload?: boolean;
  file?: string;
  line?: number;
  assetId?: string;
  environment?: string;
  remediation?: string;
}

export interface CatalogFile {
  path: string;
  type: CatalogFileKind;
  status: "ready" | "warning" | "error";
  assets: string[];
}

export interface CatalogCase {
  id: string;
  key: string;
  description?: string;
  lifecycle?: string;
  requires?: string;
  defaultRun?: string;
  line?: number;
}

export interface CatalogAsset {
  type: CatalogAssetKind;
  id: string;
  file?: string;
  exportName?: string;
  line?: number;
  description?: string;
  tags?: string[];
  protocol?: string;
  endpoint?: string;
  projectionComplete?: boolean;
  syncable: boolean;
  uploadable: boolean;
  cases?: CatalogCase[];
  nodeCount?: number;
  pathCount?: number;
  scenarios?: string[];
}

export interface CatalogEnvironment {
  name: string;
  file: string;
  exists: boolean;
  active: boolean;
  secretsFile?: string;
  tokenPresent: boolean;
  projectId?: string;
  targetId?: string;
  apiUrl?: string;
  url?: string;
  cloudCheck: "verified" | "project-verified" | "unsupported" | "invalid" | "unreachable" | "offline" | "not-run";
  sync: { status: ReadinessStatus; reasons?: string[] };
  upload: { status: ReadinessStatus; reasons?: string[]; targetId?: string };
}

export interface ProjectCatalog {
  schemaVersion: "glubean.catalog/v1";
  generatedBy: string;
  project: { name?: string; root: "." };
  summary: {
    files: number;
    assets: number;
    tests: number;
    contracts: number;
    contractCases: number;
    workflows: number;
    loadPlans: number;
    openapiPaths: number;
    environments: number;
    syncReadyEnvironments: number;
    uploadReadyEnvironments: number;
    errors: number;
    warnings: number;
  };
  environments: CatalogEnvironment[];
  files: CatalogFile[];
  assets: CatalogAsset[];
  diagnostics: CatalogDiagnostic[];
}

export interface BuildCatalogOptions {
  dir?: string;
  offline?: boolean;
  filters?: string[];
}

interface CloudReadinessResponse {
  projectId?: string;
  url?: string;
  sync?: { ready?: boolean };
  upload?: { ready?: boolean; targetId?: string; reason?: string };
}

function posix(path: string): string {
  return path.replaceAll("\\", "/");
}

function safeRelative(rootDir: string, path: string): string {
  if (!path) return path;
  const rel = relative(rootDir, resolve(path));
  return posix(rel.startsWith("..") ? path : rel);
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(() => true).catch(() => false);
}

async function readProjectName(rootDir: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(resolve(rootDir, "package.json"), "utf-8")) as { name?: unknown };
    return typeof parsed.name === "string" ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}

function classifyCatalogFile(path: string): CatalogFileKind | undefined {
  const scannerKind = classifyByStem(path);
  if (scannerKind === "flow") return "workflow";
  if (scannerKind) return scannerKind as Exclude<GlubeanFileKind, "flow">;
  const base = basename(path);
  if (/^glubean\.setup\.(?:ts|js|mjs)$/.test(base)) return "setup";
  if (/^(?:session|glubean\.session)\.(?:ts|js|mjs)$/.test(base)) return "session";
  if (base === "glubean.yaml") return "config";
  return undefined;
}

async function discoverSourceFiles(rootDir: string): Promise<Array<{ absolute: string; path: string; type: CatalogFileKind }>> {
  const found: Array<{ absolute: string; path: string; type: CatalogFileKind }> = [];
  const visit = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      const absolute = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const path = posix(relative(rootDir, absolute));
      const type = classifyCatalogFile(path);
      if (type) found.push({ absolute, path, type });
    }
  };
  await visit(rootDir);
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function inferExportFiles(
  sourceFiles: Array<{ absolute: string; path: string; type: CatalogFileKind }>,
  exports: string[],
): Promise<Map<string, string>> {
  const unresolved = new Set(exports.filter(Boolean));
  const result = new Map<string, string>();
  for (const file of sourceFiles) {
    if (file.type !== "contract" && file.type !== "workflow") continue;
    const source = await readFile(file.absolute, "utf-8").catch(() => "");
    for (const exportName of [...unresolved]) {
      const pattern = exportName === "default"
        ? /\bexport\s+default\b/
        : new RegExp(`\\bexport\\s+(?:const|let|var|function|class)\\s+${escapeRegex(exportName)}\\b`);
      if (pattern.test(source)) {
        result.set(exportName, file.path);
        unresolved.delete(exportName);
      }
    }
  }
  return result;
}

function contractCases(contract: ProjectedContract): CatalogCase[] {
  const projection = contract.projection as {
    cases?: Array<{
      key?: unknown;
      description?: unknown;
      lifecycle?: unknown;
      requires?: unknown;
      defaultRun?: unknown;
      line?: unknown;
    }>;
  };
  return (projection.cases ?? []).flatMap((item) => {
    if (typeof item.key !== "string") return [];
    return [{
      id: `${contract.contractId}.${item.key}`,
      key: item.key,
      ...(typeof item.description === "string" ? { description: item.description } : {}),
      ...(typeof item.lifecycle === "string" ? { lifecycle: item.lifecycle } : {}),
      ...(typeof item.requires === "string" ? { requires: item.requires } : {}),
      ...(typeof item.defaultRun === "string" ? { defaultRun: item.defaultRun } : {}),
      ...(typeof item.line === "number" ? { line: item.line } : {}),
    }];
  });
}

function diagnosticFromWarning(rootDir: string, warning: string): CatalogDiagnostic {
  const message = warning.replaceAll(rootDir, ".");
  const fileMatch = message.match(/(?:from|failed:)\s+([^—:]+\.(?:ts|js|mjs))/i);
  const file = fileMatch?.[1] ? posix(fileMatch[1].replace(/^\.\//, "")) : undefined;
  const contractImport = warning.startsWith("Contract import failed:");
  const workflowImport = warning.startsWith("Flow import failed:");
  const extraction = warning.startsWith("Failed to extract metadata from");
  return {
    severity: contractImport || workflowImport || extraction ? "error" : "warning",
    code: contractImport
      ? "contract_import_failed"
      : workflowImport
        ? "workflow_import_failed"
        : extraction
          ? "test_extraction_failed"
          : "scanner_warning",
    message,
    ...(contractImport || workflowImport || extraction ? { blocksSync: true } : {}),
    ...(file ? { file } : {}),
    remediation: "Fix the source file and run glubean discover again.",
  };
}

function parseErrorCode(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const error = (body as { error?: unknown }).error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return undefined;
}

async function fetchCloudReadiness(
  apiUrl: string,
  projectId: string,
  token: string,
  targetId?: string,
): Promise<{
  check: CatalogEnvironment["cloudCheck"];
  url?: string;
  sync: { status: ReadinessStatus; reasons?: string[] };
  upload: { status: ReadinessStatus; reasons?: string[]; targetId?: string };
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const base = apiUrl.replace(/\/+$/, "");
    const query = targetId ? `?targetId=${encodeURIComponent(targetId)}` : "";
    const response = await fetch(`${base}/v1/projects/${encodeURIComponent(projectId)}/readiness${query}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null) as CloudReadinessResponse | null;
    if (response.ok && body?.sync?.ready === true) {
      const uploadReady = body.upload?.ready === true;
      return {
        check: "verified",
        ...(typeof body.url === "string" ? { url: body.url } : {}),
        sync: { status: "ready" },
        upload: uploadReady
          ? { status: "ready", ...(body.upload?.targetId ? { targetId: body.upload.targetId } : {}) }
          : { status: "blocked", reasons: [body.upload?.reason ?? "No upload target is available."] },
      };
    }
    if (response.status === 401 || response.status === 403) {
      const code = parseErrorCode(body);
      const reason = code === "insufficient_scope"
        ? "Token is missing the runs:write scope."
        : code === "read_only"
          ? "The token owner has a read-only project role."
          : "Token authentication failed.";
      return {
        check: "invalid",
        sync: { status: "blocked", reasons: [reason] },
        upload: { status: "blocked", reasons: [reason] },
      };
    }
    if (response.status !== 404) {
      return {
        check: "invalid",
        sync: { status: "blocked", reasons: [`Readiness check returned HTTP ${response.status}.`] },
        upload: { status: "blocked", reasons: [`Readiness check returned HTTP ${response.status}.`] },
      };
    }

    // Older Platform API: verify token + project through the existing read path.
    // This cannot prove runs:write, so report unverified rather than a false ready.
    const project = await checkUploadAuth(apiUrl, projectId, token);
    if (!project.proceed) {
      const check = project.status === 0 ? "unreachable" : "invalid";
      const reason = project.status === 0
        ? "Platform API is unreachable."
        : `Token/project validation returned HTTP ${project.status}.`;
      return {
        check,
        sync: { status: project.status === 0 ? "unverified" : "blocked", reasons: [reason] },
        upload: { status: project.status === 0 ? "unverified" : "blocked", reasons: [reason] },
      };
    }
    if (targetId) {
      const target = await checkTargetInProject(apiUrl, projectId, targetId, token);
      if (!target.proceed && target.status !== 403) {
        return {
          check: "project-verified",
          sync: { status: "unverified" },
          upload: { status: "blocked", reasons: [`Target validation returned HTTP ${target.status}.`] },
        };
      }
    }
    return {
      check: project.unverified ? "unsupported" : "project-verified",
      sync: { status: "unverified" },
      upload: { status: "unverified", ...(targetId ? { targetId } : {}) },
    };
  } catch {
    return {
      check: "unreachable",
      sync: { status: "unverified", reasons: ["Platform API is unreachable."] },
      upload: { status: "unverified", reasons: ["Platform API is unreachable."] },
    };
  } finally {
    clearTimeout(timer);
  }
}

function isTemplateEnvFile(name: string): boolean {
  const parts = name.toLowerCase().split(".");
  return parts.some((part) => TEMPLATE_ENV_PARTS.has(part));
}

function isSecretsEnvFile(name: string): boolean {
  return name === ".env.secrets" || name.includes(".secrets.") || name.endsWith(".secrets");
}

function environmentName(file: string): string {
  return file === ".env" ? "default" : file.slice(".env.".length);
}

async function discoverEnvironmentFiles(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => []);
  const files = entries
    .filter((entry) => entry.isFile() && (entry.name === ".env" || entry.name.startsWith(".env.")))
    .map((entry) => entry.name)
    .filter((name) => !isSecretsEnvFile(name) && !isTemplateEnvFile(name));
  if (!files.includes(".env")) files.push(".env");
  return [...new Set(files)].sort((a, b) => {
    if (a === ".env") return -1;
    if (b === ".env") return 1;
    return a.localeCompare(b);
  });
}

async function buildEnvironments(rootDir: string, offline: boolean): Promise<{ environments: CatalogEnvironment[]; diagnostics: CatalogDiagnostic[] }> {
  const files = await discoverEnvironmentFiles(rootDir);
  const activeName = await readActiveEnv(rootDir);
  const environments: CatalogEnvironment[] = [];
  const diagnostics: CatalogDiagnostic[] = [];

  for (const file of files) {
    const name = environmentName(file);
    const exists = await pathExists(resolve(rootDir, file));
    const secretsFile = `${file}.secrets`;
    const secretsExist = await pathExists(resolve(rootDir, secretsFile));
    const loaded = await loadProjectEnv(rootDir, file);
    const sources = { envFileVars: { ...loaded.vars, ...loaded.secrets } };
    const token = await resolveToken({}, sources);
    const projectId = await resolveProjectId({}, sources);
    const targetId = await resolveTargetId({}, sources);
    const apiUrl = await resolveApiUrl({}, sources);
    const localSyncReasons: string[] = [];
    const localUploadReasons: string[] = [];
    if (!token) {
      localSyncReasons.push("Missing GLUBEAN_TOKEN.");
      localUploadReasons.push("Missing GLUBEAN_TOKEN.");
    }
    if (!projectId) {
      localSyncReasons.push("Missing GLUBEAN_PROJECT_ID.");
      localUploadReasons.push("Missing GLUBEAN_PROJECT_ID.");
    }
    if (!apiUrl) {
      localSyncReasons.push("Platform API URL could not be resolved.");
      localUploadReasons.push("Platform API URL could not be resolved.");
    }

    let cloudCheck: CatalogEnvironment["cloudCheck"] = "not-run";
    let sync: CatalogEnvironment["sync"] = localSyncReasons.length
      ? { status: "blocked", reasons: localSyncReasons }
      : { status: "unverified", reasons: ["Cloud token and scope have not been verified."] };
    let upload: CatalogEnvironment["upload"] = localUploadReasons.length
      ? { status: "blocked", reasons: localUploadReasons }
      : { status: "unverified", reasons: ["Cloud token, scope, and target have not been verified."], ...(targetId ? { targetId } : {}) };
    let url: string | undefined;

    if (offline) {
      cloudCheck = "offline";
    } else if (token && projectId && apiUrl) {
      const checked = await fetchCloudReadiness(apiUrl, projectId, token, targetId ?? undefined);
      cloudCheck = checked.check;
      sync = checked.sync;
      upload = checked.upload;
      url = checked.url;
    }

    const environment: CatalogEnvironment = {
      name,
      file,
      exists,
      active: activeName === name || (!activeName && file === ".env"),
      ...(secretsExist ? { secretsFile } : {}),
      tokenPresent: Boolean(token),
      ...(projectId ? { projectId } : {}),
      ...(targetId ? { targetId } : {}),
      ...(apiUrl ? { apiUrl } : {}),
      ...(url ? { url } : {}),
      cloudCheck,
      sync,
      upload,
    };
    environments.push(environment);

    const sharedReasons = new Set(
      (sync.reasons ?? []).filter((reason) => upload.reasons?.includes(reason)),
    );
    for (const reason of sharedReasons) {
      const blocked = sync.status === "blocked" || upload.status === "blocked";
      diagnostics.push({
        severity: blocked ? "error" : "warning",
        code: blocked ? "sync_upload_not_ready" : "sync_upload_unverified",
        message: reason,
        environment: name,
        ...(sync.status === "blocked" ? { blocksSync: true } : {}),
        ...(upload.status === "blocked" ? { blocksUpload: true } : {}),
      });
    }
    for (const reason of (sync.reasons ?? []).filter((item) => !sharedReasons.has(item))) {
      if (sync.status === "ready") continue;
      diagnostics.push({
        severity: sync.status === "blocked" ? "error" : "warning",
        code: sync.status === "blocked" ? "sync_not_ready" : "sync_unverified",
        message: reason,
        environment: name,
        ...(sync.status === "blocked" ? { blocksSync: true } : {}),
      });
    }
    for (const reason of (upload.reasons ?? []).filter((item) => !sharedReasons.has(item))) {
      if (upload.status === "ready") continue;
      diagnostics.push({
        severity: upload.status === "blocked" ? "error" : "warning",
        code: upload.status === "blocked" ? "upload_not_ready" : "upload_unverified",
        message: reason,
        environment: name,
        ...(upload.status === "blocked" ? { blocksUpload: true } : {}),
      });
    }
  }
  return { environments, diagnostics };
}

function wildcardRegex(pattern: string): RegExp {
  let source = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        source += ".*";
        i++;
      } else {
        source += "[^/]*";
      }
    } else if (ch === "?") {
      source += ".";
    } else {
      source += escapeRegex(ch);
    }
  }
  return new RegExp(`${source}$`, "i");
}

function matchesAssetFilter(asset: CatalogAsset, filter: string): boolean {
  const separator = filter.indexOf(":");
  if (separator > 0) {
    const field = filter.slice(0, separator).toLowerCase();
    const value = filter.slice(separator + 1);
    const regex = wildcardRegex(value);
    if (field === "type") return regex.test(asset.type);
    if (field === "file") return Boolean(asset.file && regex.test(asset.file));
    if (field === "tag") return Boolean(asset.tags?.some((tag) => regex.test(tag)));
    if (field === "id") return regex.test(asset.id);
    throw new Error(`Unknown discover filter field "${field}". Use type:, file:, tag:, id:, or env:.`);
  }
  return wildcardRegex(filter).test(asset.id);
}

function summarize(catalog: Omit<ProjectCatalog, "summary">): ProjectCatalog["summary"] {
  const count = (kind: CatalogAssetKind) => catalog.assets.filter((asset) => asset.type === kind).length;
  return {
    files: catalog.files.length,
    assets: catalog.assets.length,
    tests: count("test"),
    contracts: count("contract"),
    contractCases: catalog.assets
      .filter((asset) => asset.type === "contract")
      .reduce((sum, asset) => sum + (asset.cases?.length ?? 0), 0),
    workflows: count("workflow"),
    loadPlans: count("load"),
    openapiPaths: catalog.assets.find((asset) => asset.type === "openapi")?.pathCount ?? 0,
    environments: catalog.environments.length,
    syncReadyEnvironments: catalog.environments.filter((env) => env.sync.status === "ready").length,
    uploadReadyEnvironments: catalog.environments.filter((env) => env.upload.status === "ready").length,
    errors: catalog.diagnostics.filter((item) => item.severity === "error").length,
    warnings: catalog.diagnostics.filter((item) => item.severity === "warning").length,
  };
}

export function filterProjectCatalog(catalog: ProjectCatalog, filters: string[]): ProjectCatalog {
  if (filters.length === 0) return catalog;
  const envFilters = filters.filter((filter) => filter.toLowerCase().startsWith("env:"));
  const assetFilters = filters.filter((filter) => !filter.toLowerCase().startsWith("env:"));
  const assets = assetFilters.length
    ? catalog.assets.filter((asset) => assetFilters.every((filter) => matchesAssetFilter(asset, filter)))
    : catalog.assets;
  const assetIds = new Set(assets.map((asset) => asset.id));
  const files = assetFilters.length
    ? catalog.files.filter((file) => file.status !== "ready" || file.assets.some((id) => assetIds.has(id)))
    : catalog.files;
  const environments = envFilters.length
    ? catalog.environments.filter((env) => envFilters.every((filter) => wildcardRegex(filter.slice(4)).test(env.name)))
    : catalog.environments;
  const diagnostics = catalog.diagnostics.filter((item) => {
    if (item.assetId && assetFilters.length && !assetIds.has(item.assetId)) return false;
    if (item.environment && envFilters.length && !environments.some((env) => env.name === item.environment)) return false;
    return true;
  });
  const { summary: _summary, ...withoutSummary } = catalog;
  const base: Omit<ProjectCatalog, "summary"> = { ...withoutSummary, assets, files, environments, diagnostics };
  return { ...base, summary: summarize(base) };
}

function duplicateDiagnostics(assets: CatalogAsset[]): CatalogDiagnostic[] {
  const diagnostics: CatalogDiagnostic[] = [];
  const seen = new Map<string, CatalogAsset>();
  for (const asset of assets) {
    const key = `${asset.type}:${asset.id}`;
    const first = seen.get(key);
    if (!first) {
      seen.set(key, asset);
      continue;
    }
    diagnostics.push({
      severity: "error",
      code: "duplicate_asset_id",
      message: `Duplicate ${asset.type} id "${asset.id}"${first.file || asset.file ? ` in ${[first.file, asset.file].filter(Boolean).join(" and ")}` : ""}.`,
      assetId: asset.id,
      ...(asset.file ? { file: asset.file } : {}),
      blocksSync: asset.type !== "load",
      blocksUpload: asset.type === "test" || asset.type === "load",
    });
  }
  return diagnostics;
}

export async function buildProjectCatalog(options: BuildCatalogOptions = {}): Promise<{ rootDir: string; catalog: ProjectCatalog }> {
  const start = resolve(options.dir ?? process.cwd());
  const { rootDir } = await findProjectConfig(start);
  const projections: ProjectionResult = await buildProjections(rootDir);
  const sourceFiles = await discoverSourceFiles(rootDir);
  const exportFiles = await inferExportFiles(
    sourceFiles,
    [...projections.contracts.map((item) => item.exportName), ...projections.workflows.map((item) => item.exportName)],
  );
  const diagnostics: CatalogDiagnostic[] = [
    ...projections.errors.map((error) => ({
      severity: "error" as const,
      code: "test_projection_failed",
      message: error.message,
      file: safeRelative(rootDir, error.file),
      blocksSync: true,
      remediation: "Fix the source file and run glubean discover again.",
    })),
    ...projections.warnings.map((warning) => diagnosticFromWarning(rootDir, warning)),
    ...projections.emptyTestFiles.map((file) => ({
      severity: "error" as const,
      code: "empty_test_file",
      message: "Glubean test file produced no extractable tests.",
      file: posix(file),
      blocksSync: true,
      remediation: "Export a Glubean test or rename/remove the test suffix.",
    })),
  ];

  const assets: CatalogAsset[] = [];
  for (const test of projections.projected) {
    const file = safeRelative(rootDir, test.file);
    assets.push({
      type: "test",
      id: test.testId,
      file,
      exportName: test.exportName,
      ...(test.description ? { description: test.description } : {}),
      ...(test.tags?.length ? { tags: [...test.tags].sort() } : {}),
      projectionComplete: test.projectionComplete,
      syncable: true,
      uploadable: test.requires !== "browser" && test.requires !== "out-of-band" && test.defaultRun !== "opt-in" && !test.skipped,
    });
    if (!test.projectionComplete) {
      diagnostics.push({
        severity: "warning",
        code: "partial_test_projection",
        message: test.incompleteReason ?? "Test projection is partial.",
        assetId: test.testId,
        file,
      });
    }
  }
  for (const contract of projections.contracts) {
    const file = contract.sourceFile ?? exportFiles.get(contract.exportName);
    const cases = contractCases(contract);
    assets.push({
      type: "contract",
      id: contract.contractId,
      ...(file ? { file: posix(file) } : {}),
      exportName: contract.exportName,
      ...(contract.line ? { line: contract.line } : {}),
      ...(contract.description ? { description: contract.description } : {}),
      ...(contract.tags?.length ? { tags: [...contract.tags].sort() } : {}),
      protocol: contract.protocol,
      ...(contract.target ? { endpoint: contract.target } : {}),
      projectionComplete: contract.projectionComplete,
      syncable: true,
      uploadable: cases.some((item) => item.lifecycle !== "deferred" && item.lifecycle !== "deprecated"),
      cases,
    });
    if (cases.length === 0) {
      diagnostics.push({
        severity: "warning",
        code: "contract_has_no_cases",
        message: "Contract has no discovered cases.",
        assetId: contract.contractId,
        ...(file ? { file: posix(file) } : {}),
      });
    }
    if (!contract.projectionComplete) {
      diagnostics.push({
        severity: "warning",
        code: "partial_contract_projection",
        message: contract.incompleteReason ?? "Contract projection is partial.",
        assetId: contract.contractId,
        ...(file ? { file: posix(file) } : {}),
      });
    }
  }
  for (const workflow of projections.workflows) {
    const file = exportFiles.get(workflow.exportName);
    assets.push({
      type: "workflow",
      id: workflow.workflowId,
      ...(file ? { file } : {}),
      exportName: workflow.exportName,
      ...(workflow.name ? { description: workflow.name } : {}),
      ...(workflow.tags?.length ? { tags: [...workflow.tags].sort() } : {}),
      projectionComplete: workflow.projectionComplete,
      syncable: true,
      uploadable: true,
      nodeCount: workflow.nodeCount,
    });
    if (!workflow.projectionComplete) {
      diagnostics.push({
        severity: "warning",
        code: "partial_workflow_projection",
        message: workflow.incompleteReason ?? "Workflow projection is partial.",
        assetId: workflow.workflowId,
        ...(file ? { file } : {}),
      });
    }
  }
  const openapiPaths = projections.openapi && typeof projections.openapi === "object"
    ? Object.keys((projections.openapi.paths as Record<string, unknown> | undefined) ?? {}).length
    : 0;
  if (openapiPaths > 0) {
    assets.push({ type: "openapi", id: "openapi", pathCount: openapiPaths, syncable: !projections.openapiFailed, uploadable: false });
  }
  if (projections.openapiFailed) {
    diagnostics.push({
      severity: "warning",
      code: "openapi_projection_failed",
      message: "OpenAPI rendering failed; sync would preserve the previous Cloud document.",
    });
  }

  for (const file of sourceFiles.filter((item) => item.type === "load")) {
    const extracted = await extractLoadPlansFromFile(file.absolute);
    if (extracted.error) {
      diagnostics.push({
        severity: "error",
        code: "load_import_failed",
        message: extracted.error,
        file: file.path,
        blocksUpload: true,
      });
    }
    for (const plan of extracted.plans) {
      assets.push({
        type: "load",
        id: plan.runnerId,
        file: file.path,
        exportName: plan.exportName,
        syncable: false,
        uploadable: true,
        scenarios: plan.scenarios.map((scenario) => scenario.scenarioId),
      });
    }
  }

  assets.sort((a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
  diagnostics.push(...duplicateDiagnostics(assets));

  const assetFiles = new Map<string, string[]>();
  for (const asset of assets) {
    if (!asset.file) continue;
    const list = assetFiles.get(asset.file) ?? [];
    list.push(asset.id);
    assetFiles.set(asset.file, list);
  }
  const files: CatalogFile[] = sourceFiles.map((file) => {
    const relatedDiagnostics = diagnostics.filter((item) => item.file === file.path);
    const status = relatedDiagnostics.some((item) => item.severity === "error")
      ? "error"
      : relatedDiagnostics.length > 0
        ? "warning"
        : "ready";
    const relatedAssets = (assetFiles.get(file.path) ?? []).sort();
    if (relatedAssets.length === 0 && ["test", "contract", "workflow", "load"].includes(file.type) && status === "ready") {
      diagnostics.push({
        severity: "warning",
        code: "file_has_no_assets",
        message: `Recognized ${file.type} file produced no catalog assets.`,
        file: file.path,
      });
      return { path: file.path, type: file.type, status: "warning", assets: [] };
    }
    return { path: file.path, type: file.type, status, assets: relatedAssets };
  });

  if (!assets.some((asset) => asset.syncable)) {
    diagnostics.push({
      severity: "error",
      code: "no_sync_assets",
      message: "No syncable tests, contracts, workflows, or OpenAPI paths were discovered.",
      blocksSync: true,
    });
  }

  const environmentResult = await buildEnvironments(rootDir, options.offline ?? false);
  diagnostics.push(...environmentResult.diagnostics);
  diagnostics.sort((a, b) => {
    const rank = { error: 0, warning: 1, info: 2 } as const;
    return rank[a.severity] - rank[b.severity] || (a.file ?? "").localeCompare(b.file ?? "") || a.code.localeCompare(b.code);
  });

  const projectName = await readProjectName(rootDir);
  const base: Omit<ProjectCatalog, "summary"> = {
    schemaVersion: "glubean.catalog/v1",
    generatedBy: `@glubean/cli@${CLI_VERSION}`,
    project: { ...(projectName ? { name: projectName } : {}), root: "." },
    environments: environmentResult.environments,
    files,
    assets,
    diagnostics,
  };
  const catalog: ProjectCatalog = { ...base, summary: summarize(base) };
  return { rootDir, catalog: filterProjectCatalog(catalog, options.filters ?? []) };
}

export function catalogHasBlockingIssues(catalog: ProjectCatalog): boolean {
  return catalog.diagnostics.some((item) => item.blocksSync || item.blocksUpload);
}

export function serializeCatalog(catalog: ProjectCatalog, format: "yaml" | "json"): string {
  return format === "json"
    ? `${JSON.stringify(catalog, null, 2)}\n`
    : stringifyYaml(catalog, { lineWidth: 0 });
}

export async function writeCatalog(path: string, catalog: ProjectCatalog, format: "yaml" | "json"): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, serializeCatalog(catalog, format), "utf-8");
  const { rename } = await import("node:fs/promises");
  await rename(temporary, path);
}
