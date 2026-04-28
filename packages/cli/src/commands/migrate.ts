import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

// `typescript` is intentionally lazy-loaded. The CLI ships it as a `devDependency`
// (and a soft `peerDependency`) — bundling the ~60MB compiler into the standard
// install path would hit every CLI user just for `glubean migrate`. Most v0.1.x
// projects already have `typescript` installed; if not, we fail with a clear
// install hint instead of silently importing nothing.
type TS = typeof import("typescript");
async function loadTypeScript(rootDir: string): Promise<TS> {
  // Try the project's own `typescript` first — a globally or npx-installed
  // `glubean` would otherwise resolve to the CLI package itself, missing the
  // version the project uses (or failing entirely if the project has TS but
  // the CLI doesn't carry it as a dependency).
  const candidates = [
    // Project-local: resolves from the project being migrated
    () => createRequire(join(rootDir, "package.json")).resolve("typescript"),
    // CLI-local fallback: bare `require` is undefined in ESM; use createRequire rooted at this file
    () => createRequire(import.meta.url).resolve("typescript"),
  ];
  for (const candidate of candidates) {
    try {
      const resolved = candidate();
      return (await import(resolved)).default as TS;
    } catch {
      // try next
    }
  }
  throw new Error(
    "glubean migrate requires the `typescript` package. Run `npm install -D typescript` (or pnpm/yarn equivalent) and retry.",
  );
}

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

const IGNORED_DIRS = new Set([
  ".git",
  ".glubean",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);

const CONTRACT_PLUGIN_IMPORTS: Record<string, { packageName: string; localName: string }> = {
  "@glubean/grpc": { packageName: "@glubean/grpc", localName: "grpcPlugin" },
  "@glubean/graphql": { packageName: "@glubean/graphql", localName: "graphqlPlugin" },
};

export interface MigrateCommandOptions {
  dir?: string;
  apply?: boolean;
}

interface Replacement {
  start: number;
  end: number;
  text: string;
}

interface ManualFinding {
  file: string;
  line: number;
  code:
    | "legacy-lifecycle"
    | "legacy-plugin"
    | "needs-factory"
    | "legacy-http-bare";
  message: string;
}

interface AutoFix {
  file: string;
  line: number;
  message: string;
}

interface FilePlan {
  file: string;
  original: string;
  next: string;
  fixes: AutoFix[];
  manual: ManualFinding[];
}

interface MigratePlan {
  rootDir: string;
  files: FilePlan[];
  setupPlugins: Set<string>;
}

export async function migrateCommand(options: MigrateCommandOptions = {}): Promise<void> {
  const rootDir = resolve(options.dir ?? ".");
  const apply = options.apply === true;
  const plan = await planMigration(rootDir);
  const changedFiles = plan.files.filter((file) => file.original !== file.next);
  const fixes = plan.files.flatMap((file) => file.fixes);
  const manual = plan.files.flatMap((file) => file.manual);

  console.log(`${colors.bold}Glubean migrate${colors.reset} v0.1.x -> v10`);
  console.log(`${colors.dim}Mode: ${apply ? "apply" : "dry-run"}${colors.reset}`);
  console.log("");

  if (fixes.length === 0 && manual.length === 0) {
    console.log(`${colors.green}No legacy patterns found.${colors.reset}`);
    return;
  }

  if (fixes.length > 0) {
    console.log(`${colors.bold}Automatic changes${colors.reset}`);
    for (const fix of fixes) {
      console.log(`  ${colors.cyan}${relative(rootDir, fix.file)}:${fix.line}${colors.reset} ${fix.message}`);
    }
    console.log("");
  }

  if (manual.length > 0) {
    console.log(`${colors.bold}Manual review${colors.reset}`);
    for (const item of manual) {
      console.log(`  ${colors.yellow}${relative(rootDir, item.file)}:${item.line}${colors.reset} ${item.message}`);
    }
    console.log("");
  }

  if (changedFiles.length > 0) {
    console.log(`${colors.bold}Preview diff${colors.reset}`);
    for (const file of changedFiles) {
      process.stdout.write(renderDiff(relative(rootDir, file.file), file.original, file.next));
    }
    console.log("");
  }

  if (apply) {
    for (const file of changedFiles) {
      await mkdir(dirname(file.file), { recursive: true });
      await writeFile(file.file, file.next, "utf-8");
    }
    console.log(`${colors.green}Applied${colors.reset} ${changedFiles.length} file(s).`);
  } else if (changedFiles.length > 0) {
    console.log(`${colors.dim}Run ${colors.cyan}glubean migrate --apply${colors.dim} to write these changes.${colors.reset}`);
  }
}

export async function planMigration(rootDir: string): Promise<MigratePlan> {
  const ts = await loadTypeScript(rootDir);
  const files = await collectTypeScriptFiles(rootDir);
  const filePlans: FilePlan[] = [];
  const setupPlugins = new Set<string>();

  for (const file of files) {
    const source = await readFile(file, "utf-8");
    const plan = planFileMigration(ts, rootDir, file, source);
    for (const plugin of plan.setupPlugins) setupPlugins.add(plugin);
    filePlans.push({
      file,
      original: source,
      next: applyReplacements(source, plan.replacements),
      fixes: plan.fixes,
      manual: plan.manual,
    });
  }

  if (setupPlugins.size > 0) {
    const setupPath = resolve(rootDir, "glubean.setup.ts");
    const existing = filePlans.find((file) => file.file === setupPath);
    if (existing) {
      const next = ensureSetupInstalls(existing.next, setupPlugins);
      if (next !== existing.next) {
        existing.fixes.push({
          file: setupPath,
          line: 1,
          message: "Install contract plugin manifests from glubean.setup.ts.",
        });
        existing.next = next;
      }
    } else {
      const source = ensureSetupInstalls("", setupPlugins);
      filePlans.push({
        file: setupPath,
        original: "",
        next: source,
        fixes: [
          {
            file: setupPath,
            line: 1,
            message: "Create glubean.setup.ts with contract plugin manifests.",
          },
        ],
        manual: [],
      });
    }
  }

  return { rootDir, files: filePlans, setupPlugins };
}

function planFileMigration(ts: TS, rootDir: string, file: string, source: string): {
  replacements: Replacement[];
  fixes: AutoFix[];
  manual: ManualFinding[];
  setupPlugins: Set<string>;
} {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const replacements: Replacement[] = [];
  const fixes: AutoFix[] = [];
  const manual: ManualFinding[] = [];
  const setupPlugins = new Set<string>();
  const legacyHttpCalls: import("typescript").CallExpression[] = [];
  const removedImports = new Set<import("typescript").ImportDeclaration>();

  // Track the LOCAL binding names bound to `@glubean/sdk`'s `definePlugin`.
  // Using a Set handles `import { definePlugin as glubeanPlugin }` aliases —
  // the old single-flag approach only checked for a callee named literally
  // "definePlugin", so aliases were missed and unrelated `definePlugin` from
  // other libraries could still be false-positived when the file also imported
  // the SDK symbol under an alias.
  const definePluginLocals = new Set<string>();

  // Detect whether the file already declares its own scoped HTTP instance via
  // `contract.http.with(...)`. If so, the user is past the trivial-bare-call
  // pattern and an empty `contract.http.with("<stem>", {})` synthesised by
  // migrate would clobber meaningful local config. Refuse the auto-rewrite —
  // surface a manual review instead.
  let hasExistingHttpWith = false;

  const visit = (node: import("typescript").Node): void => {
    if (ts.isImportDeclaration(node)) {
      const specifier = stringLiteralText(ts, node.moduleSpecifier);
      if (!node.importClause && specifier && CONTRACT_PLUGIN_IMPORTS[specifier]) {
        setupPlugins.add(specifier);
        removedImports.add(node);
        replacements.push(removeStatementReplacement(source, node));
        fixes.push({
          file,
          line: lineOf(ts, sourceFile, node),
          message: `Move ${specifier} side-effect plugin import to glubean.setup.ts installPlugin(...).`,
        });
      }
      if (specifier === "@glubean/sdk" && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
        for (const element of node.importClause.namedBindings.elements) {
          // Track the LOCAL name (after `as`) so aliased imports are caught:
          // `import { definePlugin as dp } from "@glubean/sdk"` → locals has "dp"
          const original = element.propertyName?.text ?? element.name.text;
          if (original === "definePlugin") {
            definePluginLocals.add(element.name.text);
          }
        }
      }
    }

    if (ts.isCallExpression(node)) {
      if (isLegacyHttpCall(ts, node)) {
        legacyHttpCalls.push(node);
      }
      if (isExistingHttpWithCall(ts, node)) {
        hasExistingHttpWith = true;
      }
      if (definePluginLocals.size > 0 && isLegacyDefinePluginCall(ts, node, definePluginLocals)) {
        manual.push({
          file,
          line: lineOf(ts, sourceFile, node),
          code: "legacy-plugin",
          message: "definePlugin((runtime) => ...) was removed; migrate to definePlugin({ matchers, protocols, setup }).",
        });
      }
    }

    if (ts.isObjectLiteralExpression(node)) {
      collectCaseFindings(ts, sourceFile, file, node, manual);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  if (legacyHttpCalls.length > 0) {
    if (hasExistingHttpWith) {
      // Bail on the auto-rewrite — the file already has a scoped HTTP instance,
      // so the synthesised `migratedHttp = contract.http.with("<stem>", {})`
      // would either collide with an existing identifier or contradict the
      // user's intentional local setup. Report each legacy call as manual.
      for (const call of legacyHttpCalls) {
        manual.push({
          file,
          line: lineOf(ts, sourceFile, call),
          code: "legacy-http-bare",
          message: 'Bare contract.http("id", spec) call found alongside an existing contract.http.with(...) instance. Rebind manually onto the scoped instance to preserve your client/baseUrl config.',
        });
      }
    } else {
      const instanceName = uniqueIdentifier(source, "migratedHttp");
      const importEnd = findImportInsertionOffset(ts, sourceFile, removedImports);
      const instanceLabel = scopedInstanceLabel(file, rootDir);
      replacements.push({
        start: importEnd,
        end: importEnd,
        text: `${source[importEnd - 1] === "\n" ? "" : "\n"}\nconst ${instanceName} = contract.http.with("${instanceLabel}", {});\n`,
      });

      for (const call of legacyHttpCalls) {
        replacements.push({
          start: call.expression.getStart(sourceFile),
          end: call.expression.getEnd(),
          text: instanceName,
        });
        fixes.push({
          file,
          line: lineOf(ts, sourceFile, call),
          message: 'Rewrite contract.http("id", spec) to a scoped contract.http.with(...) instance.',
        });
      }

      // Always surface the synthesised instance config for review — the empty
      // `{}` is a placeholder. If the user previously relied on plugin-level
      // HTTP defaults (a global client manifest), this is fine. If they were
      // bringing per-file http config they will need to add it here.
      manual.push({
        file,
        line: lineOf(ts, sourceFile, legacyHttpCalls[0]!),
        code: "legacy-http-bare",
        message: `Created ${instanceName} = contract.http.with("${instanceLabel}", {}). Review the empty options object and add client/baseUrl/headers as needed.`,
      });
    }
  }

  return { replacements, fixes, manual, setupPlugins };
}

function collectCaseFindings(
  ts: TS,
  sourceFile: import("typescript").SourceFile,
  file: string,
  object: import("typescript").ObjectLiteralExpression,
  manual: ManualFinding[],
): void {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    if (propertyName(ts, property.name) !== "cases") continue;
    if (!ts.isObjectLiteralExpression(property.initializer)) continue;

    for (const caseProp of property.initializer.properties) {
      if (!ts.isPropertyAssignment(caseProp)) continue;
      const value = caseProp.initializer;
      if (ts.isCallExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === "defineHttpCase") {
        continue;
      }
      if (!ts.isObjectLiteralExpression(value)) continue;

      for (const field of value.properties) {
        if (!ts.isPropertyAssignment(field)) continue;
        const name = propertyName(ts, field.name);
        if (name === "setup" || name === "teardown") {
          manual.push({
            file,
            line: lineOf(ts, sourceFile, field),
            code: "legacy-lifecycle",
            message: `Case-level ${name} was removed; extract lifecycle work into a bootstrap overlay or session.`,
          });
        }
        if (name === "needs") {
          manual.push({
            file,
            line: lineOf(ts, sourceFile, field),
            code: "needs-factory",
            message: "Case has needs; wrap the case in defineHttpCase<Needs>(...) to preserve body/input typing.",
          });
        }
      }
    }
  }
}

function isLegacyHttpCall(ts: TS, node: import("typescript").CallExpression): boolean {
  const expression = node.expression;
  if (!ts.isPropertyAccessExpression(expression)) return false;
  if (expression.name.text !== "http") return false;
  return ts.isIdentifier(expression.expression) && expression.expression.text === "contract";
}

/**
 * Match `contract.http.with(...)` — the v10 scoped instance constructor.
 * Used to detect "user already declared a scoped http instance in this file"
 * so we don't auto-rewrite over their config.
 */
function isExistingHttpWithCall(ts: TS, node: import("typescript").CallExpression): boolean {
  const expression = node.expression;
  if (!ts.isPropertyAccessExpression(expression)) return false;
  if (expression.name.text !== "with") return false;
  if (!ts.isPropertyAccessExpression(expression.expression)) return false;
  if (expression.expression.name.text !== "http") return false;
  return ts.isIdentifier(expression.expression.expression) && expression.expression.expression.text === "contract";
}

function isLegacyDefinePluginCall(
  ts: TS,
  node: import("typescript").CallExpression,
  locals: Set<string>,
): boolean {
  if (!ts.isIdentifier(node.expression) || !locals.has(node.expression.text)) return false;
  const first = node.arguments[0];
  return !!first && (ts.isArrowFunction(first) || ts.isFunctionExpression(first));
}

async function collectTypeScriptFiles(rootDir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) await walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!isMigratableTsFile(path)) continue;
      files.push(path);
    }
  }

  await walk(rootDir);
  files.sort();
  return files;
}

function isMigratableTsFile(path: string): boolean {
  if (!path.endsWith(".ts") || path.endsWith(".d.ts")) return false;
  const name = basename(path);
  // Migratable file conventions:
  //   - `glubean.setup.ts` — for installPlugin manifest rewrites
  //   - `*.contract.ts` / `*.flow.ts` — contract-layer files
  //   - `*.test.ts` / `*.spec.ts` — tests that may import contract surfaces
  //   - `*.plugin.ts` / `*.plugins.ts` — plugin authoring (legacy `definePlugin`).
  //     Pre-fix used `name.includes("plugin")` which over-matched any file
  //     whose name happened to contain "plugin" (e.g. `eslint-plugin.ts`,
  //     `plugin-utils.ts`). Now we only match a `.plugin.ts` / `.plugins.ts`
  //     suffix — the conventional Glubean plugin naming.
  return name === "glubean.setup.ts" ||
    name.endsWith(".contract.ts") ||
    name.endsWith(".flow.ts") ||
    name.endsWith(".test.ts") ||
    name.endsWith(".spec.ts") ||
    name.endsWith(".plugin.ts") ||
    name.endsWith(".plugins.ts");
}

function ensureSetupInstalls(source: string, plugins: Set<string>): string {
  const specs = [...plugins].filter((plugin) => CONTRACT_PLUGIN_IMPORTS[plugin]);
  if (specs.length === 0) return source;

  const trimmed = source.trim().length > 0 ? source : "";
  const linesToPrepend: string[] = [];
  if (!/from\s+["']@glubean\/sdk["']/.test(source) || !/\binstallPlugin\b/.test(source)) {
    linesToPrepend.push('import { installPlugin } from "@glubean/sdk";');
  }

  const pluginNames: string[] = [];
  for (const spec of specs) {
    const plugin = CONTRACT_PLUGIN_IMPORTS[spec]!;
    if (!new RegExp(`import\\s+${plugin.localName}\\s+from\\s+["']${escapeRegExp(plugin.packageName)}["']`).test(source)) {
      linesToPrepend.push(`import ${plugin.localName} from "${plugin.packageName}";`);
    }
    pluginNames.push(plugin.localName);
  }

  const missingPluginNames = pluginNames.filter((name) => !new RegExp(`installPlugin\\([^)]*\\b${name}\\b`, "s").test(source));
  const installLine = missingPluginNames.length > 0 ? `await installPlugin(${missingPluginNames.join(", ")});` : "";
  const prefix = linesToPrepend.length > 0 ? `${linesToPrepend.join("\n")}\n${trimmed ? "\n" : ""}` : "";
  const body = trimmed ? ensureTrailingNewline(trimmed) : "";
  const suffix = installLine ? `${body && !body.endsWith("\n\n") ? "\n" : ""}${installLine}\n` : "";
  return prefix + body + suffix;
}

function applyReplacements(source: string, replacements: Replacement[]): string {
  if (replacements.length === 0) return source;
  const sorted = [...replacements].sort((a, b) => b.start - a.start);
  let next = source;
  let lastStart = Number.POSITIVE_INFINITY;
  for (const replacement of sorted) {
    if (replacement.end > lastStart) {
      throw new Error("Internal migrate error: overlapping replacements");
    }
    next = next.slice(0, replacement.start) + replacement.text + next.slice(replacement.end);
    lastStart = replacement.start;
  }
  return next;
}

function renderDiff(file: string, oldText: string, newText: string): string {
  if (oldText === newText) return "";
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const contextBefore = Math.max(0, prefix - 3);
  const oldEnd = oldLines.length - suffix;
  const newEnd = newLines.length - suffix;
  const contextAfterOld = Math.min(oldLines.length, oldEnd + 3);
  const contextAfterNew = Math.min(newLines.length, newEnd + 3);

  const out: string[] = [
    `--- ${file}\n`,
    `+++ ${file}\n`,
    `@@ -${contextBefore + 1},${contextAfterOld - contextBefore} +${contextBefore + 1},${contextAfterNew - contextBefore} @@\n`,
  ];

  for (let i = contextBefore; i < prefix; i++) out.push(` ${oldLines[i]}`);
  for (let i = prefix; i < oldEnd; i++) out.push(`-${oldLines[i]}`);
  for (let i = prefix; i < newEnd; i++) out.push(`+${newLines[i]}`);
  for (let i = oldEnd; i < contextAfterOld; i++) out.push(` ${oldLines[i]}`);

  return out.join("");
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.match(/.*(?:\n|$)/g) ?? [];
  return lines.filter((line) => line.length > 0);
}

function findImportInsertionOffset(
  ts: TS,
  sourceFile: import("typescript").SourceFile,
  skip: Set<import("typescript").Node>,
): number {
  let offset = 0;
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && !skip.has(statement)) {
      offset = statement.end;
    }
  }
  return offset;
}

function removeStatementReplacement(source: string, node: import("typescript").Node): Replacement {
  let end = node.end;
  if (source[end] === "\r" && source[end + 1] === "\n") end += 2;
  else if (source[end] === "\n") end += 1;
  return { start: node.getStart(), end, text: "" };
}

function stringLiteralText(ts: TS, node: import("typescript").Node): string | undefined {
  return ts.isStringLiteral(node) ? node.text : undefined;
}

function propertyName(ts: TS, name: import("typescript").PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function lineOf(
  _ts: TS,
  sourceFile: import("typescript").SourceFile,
  node: import("typescript").Node,
): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function uniqueIdentifier(source: string, base: string): string {
  if (!new RegExp(`\\b${escapeRegExp(base)}\\b`).test(source)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}${i}`;
    if (!new RegExp(`\\b${escapeRegExp(candidate)}\\b`).test(source)) return candidate;
  }
  throw new Error(`Unable to find a free identifier for ${base}`);
}

function scopedInstanceLabel(file: string, rootDir: string): string {
  const rel = relative(rootDir, file);
  const base = basename(rel)
    .replace(/\.contract\.ts$/, "")
    .replace(/\.flow\.ts$/, "")
    .replace(/\.test\.ts$/, "")
    .replace(/\.spec\.ts$/, "")
    .replace(extname(rel), "");
  const cleaned = base.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "migrated-http";
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
