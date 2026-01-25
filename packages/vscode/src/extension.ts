/**
 * Glubean VS Code Extension — main entry point.
 *
 * Activates the Test Controller for ▶ play buttons, Test Explorer sidebar,
 * and pass/fail status display in the gutter.
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as cp from "child_process";
import * as testController from "./testController";
import { createHoverProvider } from "./hoverProvider";
import { createPickCodeLensProvider } from "./codeLensProvider";

// ---------------------------------------------------------------------------
// Dependency detection & one-click setup
// ---------------------------------------------------------------------------

interface DepStatus {
  deno: boolean;
  glubean: boolean;
}

/** Cache so we only check once per session (cleared by "Setup" action). */
let cachedDepStatus: DepStatus | undefined;

/** Prevent multiple setup prompts from stacking. */
let setupInProgress = false;

/**
 * Check whether a command is available on the system PATH.
 * Returns true if the command exits with code 0.
 */
function commandExists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = cp.spawn(command, ["--version"], {
      shell: true,
      stdio: "ignore",
    });
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
  });
}

/**
 * Detect whether Deno and Glubean CLI are installed.
 * Uses the configured glubeanPath from settings.
 */
async function checkDependencies(): Promise<DepStatus> {
  if (cachedDepStatus) {
    return cachedDepStatus;
  }
  const config = vscode.workspace.getConfiguration("glubean");
  const glubeanPath = config.get<string>("glubeanPath", "glubean");

  const [deno, glubean] = await Promise.all([
    commandExists("deno"),
    commandExists(glubeanPath),
  ]);
  cachedDepStatus = { deno, glubean };
  return cachedDepStatus;
}

/**
 * Run a shell command and return stdout. Rejects on non-zero exit.
 * Uses login shell so ~/.deno/bin is on PATH after Deno install.
 */
function exec(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const shell = process.platform === "win32" ? undefined : "/bin/sh";
    cp.exec(command, { shell, timeout: 120_000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

/**
 * Resolve the path to Deno binary.
 * After a fresh install, ~/.deno/bin/deno may not be on the inherited PATH,
 * so we check the well-known location as a fallback.
 */
function denoPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const wellKnown =
    process.platform === "win32"
      ? `${home}\\.deno\\bin\\deno.exe`
      : `${home}/.deno/bin/deno`;

  if (fs.existsSync(wellKnown)) {
    return wellKnown;
  }
  return "deno"; // fall back to PATH
}

/**
 * One-click setup: install Deno (if missing) and Glubean CLI.
 * Runs silently with a VS Code progress notification.
 * Returns true if setup completed successfully.
 */
async function runSetup(): Promise<boolean> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Setting up Glubean",
      cancellable: false,
    },
    async (progress) => {
      try {
        const status = await checkDependencies();

        // Step 1: Install Deno if missing
        if (!status.deno) {
          progress.report({ message: "Installing Deno runtime..." });

          if (process.platform === "win32") {
            await exec(
              'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://deno.land/install.ps1 | iex"',
            );
          } else {
            // Prefer curl; fall back to wget for minimal Linux installs
            const downloader = (await commandExists("curl"))
              ? "curl -fsSL https://deno.land/install.sh | sh"
              : "wget -qO- https://deno.land/install.sh | sh";
            await exec(downloader);
          }

          // Verify Deno is now available
          const deno = denoPath();
          try {
            await exec(`"${deno}" --version`);
          } catch {
            vscode.window.showErrorMessage(
              "Deno installation succeeded but the binary was not found. " +
                "You may need to restart VS Code so your PATH is updated.",
            );
            return false;
          }
        }

        // Step 2: Install Glubean CLI
        if (!status.glubean) {
          progress.report({ message: "Installing Glubean CLI..." });

          const deno = denoPath();
          await exec(`"${deno}" install -Agf -n glubean jsr:@glubean/cli`);
        }

        // Clear cache so next check picks up the new state
        cachedDepStatus = undefined;

        progress.report({ message: "Done! Reloading..." });

        // Brief pause so the user sees "Done!" before reload
        await new Promise((r) => setTimeout(r, 800));

        // Reload the window so all PATH changes take effect
        vscode.commands.executeCommand("workbench.action.reloadWindow");
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const shortcut =
          process.platform === "darwin" ? "Cmd+Shift+P" : "Ctrl+Shift+P";
        vscode.window.showErrorMessage(
          `Glubean setup failed: ${message}. ` +
            `You can retry with ${shortcut} → "Glubean: Setup".`,
        );
        return false;
      }
    },
  );
}

/**
 * Show the setup.md explainer, then offer to continue with installation.
 */
async function showSetupDoc(): Promise<boolean> {
  const docUri = vscode.Uri.joinPath(
    vscode.extensions.getExtension("glubean.glubean")!.extensionUri,
    "docs",
    "setup.md",
  );

  await vscode.commands.executeCommand("markdown.showPreview", docUri);

  const choice = await vscode.window.showInformationMessage(
    "Ready to install?",
    "Continue",
    "Not now",
  );

  if (choice === "Continue") {
    return await runSetup();
  }
  return false;
}

/**
 * Prompt the user to install missing dependencies.
 *
 * Single prompt, non-persistent — dismissed prompts re-appear next time the
 * user tries to run a test or on next VS Code session. This avoids the need
 * for a "don't ask again" option.
 *
 * Returns true if all dependencies are satisfied.
 */
async function promptInstallIfNeeded(): Promise<boolean> {
  const status = await checkDependencies();

  if (status.deno && status.glubean) {
    return true;
  }

  // Prevent stacking multiple prompts
  if (setupInProgress) {
    return false;
  }
  setupInProgress = true;

  try {
    // Tailor the message to what's actually missing
    const message =
      !status.deno && !status.glubean
        ? "Glubean needs a one-time setup to run TypeScript natively (~30s)."
        : !status.deno
          ? "Glubean needs to install a TypeScript runtime (Deno) to run your tests."
          : "Glubean CLI is not installed. Set it up to enable play buttons and test running.";

    const choice = await vscode.window.showInformationMessage(
      message,
      "Continue",
      "Learn more",
    );

    if (choice === "Continue") {
      return await runSetup();
    }

    if (choice === "Learn more") {
      return await showSetupDoc();
    }

    return false;
  } finally {
    setupInProgress = false;
  }
}

// ---------------------------------------------------------------------------
// Environment switcher
// ---------------------------------------------------------------------------

/** Currently selected .env file (relative to workspace root). */
let selectedEnvFile: string | undefined;

/** Status bar item showing the active environment. */
let envStatusBarItem: vscode.StatusBarItem;

/**
 * Get the currently selected env file path (relative to workspace root).
 * Returns undefined when using the default .env.
 */
export function getSelectedEnvFile(): string | undefined {
  return selectedEnvFile;
}

/**
 * Derive a short display name from an env file path.
 * ".env" → "default", ".env.staging" → "staging", ".env.prod" → "prod"
 */
function envDisplayName(envFile: string): string {
  if (envFile === ".env") return "default";
  const match = envFile.match(/^\.env\.(.+)$/);
  return match ? match[1] : envFile;
}

/**
 * Detect .env* files in the workspace root.
 * Returns file names like [".env", ".env.dev", ".env.staging", ".env.prod"].
 */
async function detectEnvFiles(): Promise<string[]> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) return [".env"];

  try {
    const entries = fs.readdirSync(workspaceRoot);
    const envFiles = entries
      .filter(
        (f) =>
          f === ".env" ||
          (f.startsWith(".env.") &&
            !f.endsWith(".secrets") &&
            !f.endsWith(".local") &&
            !f.endsWith(".example")),
      )
      .sort();
    return envFiles.length > 0 ? envFiles : [".env"];
  } catch {
    return [".env"];
  }
}

/**
 * Initialize the environment status bar item and picker command.
 */
function activateEnvSwitcher(context: vscode.ExtensionContext): void {
  // Restore previous selection from workspace state
  selectedEnvFile = context.workspaceState.get<string>(
    "glubean.selectedEnvFile",
  );

  // Create status bar item
  envStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  envStatusBarItem.command = "glubean.selectEnv";
  envStatusBarItem.tooltip = "Glubean: Select environment (.env file)";
  updateEnvStatusBar();
  envStatusBarItem.show();
  context.subscriptions.push(envStatusBarItem);

  // Register the picker command
  context.subscriptions.push(
    vscode.commands.registerCommand("glubean.selectEnv", async () => {
      const envFiles = await detectEnvFiles();

      const items = envFiles.map((f) => ({
        label: envDisplayName(f),
        description: f,
        picked: (selectedEnvFile || ".env") === f,
      }));

      const choice = await vscode.window.showQuickPick(items, {
        placeHolder: "Select environment",
        title: "Glubean Environment",
      });

      if (choice) {
        selectedEnvFile =
          choice.description === ".env" ? undefined : choice.description;
        context.workspaceState.update(
          "glubean.selectedEnvFile",
          selectedEnvFile,
        );
        updateEnvStatusBar();
      }
    }),
  );
}

/** Update the status bar text to reflect the current environment. */
function updateEnvStatusBar(): void {
  const label = envDisplayName(selectedEnvFile || ".env");
  envStatusBarItem.text = `$(server-environment) env: ${label}`;
}

// ---------------------------------------------------------------------------
// Extension lifecycle
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  // Activate the Test Controller (discovery + run)
  testController.activate(context);

  // Wire up pre-run dependency check — blocks test execution if deps are missing
  testController.setPreRunCheck(promptInstallIfNeeded);

  // ── Environment switcher ───────────────────────────────────────────────
  activateEnvSwitcher(context);
  testController.setEnvFileProvider(getSelectedEnvFile);

  // ── Hover provider (vars/secrets preview) ─────────────────────────────
  const hoverSelector: vscode.DocumentSelector = [
    { language: "typescript", pattern: "**/*.test.ts" },
    { language: "typescript", pattern: "**/*.explore.ts" },
  ];
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      hoverSelector,
      createHoverProvider(getSelectedEnvFile),
    ),
  );

  // ── CodeLens provider (test.pick example buttons) ───────────────────────
  const codeLensSelector: vscode.DocumentSelector = [
    { language: "typescript", pattern: "**/*.test.ts" },
    { language: "typescript", pattern: "**/*.explore.ts" },
  ];
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      codeLensSelector,
      createPickCodeLensProvider("glubean.runPick"),
    ),
  );

  // ── Dependency check on activation (non-blocking) ──────────────────────
  promptInstallIfNeeded();

  // ── Commands ────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("glubean.runFile", async () => {
      const editor = vscode.window.activeTextEditor;
      const fileName = editor?.document.fileName ?? "";
      if (
        !editor ||
        (!fileName.endsWith(".test.ts") && !fileName.endsWith(".explore.ts"))
      ) {
        vscode.window.showWarningMessage(
          "Open a .test.ts or .explore.ts file to run.",
        );
        return;
      }

      const terminal = getOrCreateTerminal();
      terminal.show();
      terminal.sendText(`glubean run "${editor.document.fileName}"`);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("glubean.runWorkspace", async () => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showWarningMessage("No workspace folder open.");
        return;
      }

      const terminal = getOrCreateTerminal();
      terminal.show();
      terminal.sendText(`glubean run "${workspaceFolder.uri.fsPath}"`);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("glubean.openLastResult", async () => {
      const resultPath = testController.getLastResultJsonPath();
      if (!resultPath || !fs.existsSync(resultPath)) {
        vscode.window.showInformationMessage(
          "No result JSON available. Run a test first.",
        );
        return;
      }
      const doc = await vscode.workspace.openTextDocument(resultPath);
      await vscode.window.showTextDocument(doc, {
        preview: false,
        viewColumn: vscode.ViewColumn.Beside,
      });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("glubean.checkDependencies", async () => {
      cachedDepStatus = undefined; // clear cache
      const status = await checkDependencies();
      if (status.deno && status.glubean) {
        vscode.window.showInformationMessage(
          "Glubean: All dependencies are installed.",
        );
      } else {
        await runSetup();
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("glubean.rerunLast", async () => {
      const ok = await testController.rerunLast();
      if (!ok) {
        vscode.window.showInformationMessage(
          "No previous run to repeat. Run a test or explore first.",
        );
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("glubean.diffPrevious", async () => {
      const ok = await testController.diffWithPrevious();
      if (!ok) {
        vscode.window.showInformationMessage(
          "Need at least two previous runs to diff. Run again first.",
        );
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("glubean.copyAsCurl", async () => {
      const ok = await testController.copyAsCurl();
      if (ok) {
        vscode.window.showInformationMessage(
          "cURL command copied to clipboard.",
        );
      } else {
        vscode.window.showWarningMessage(
          "Open a .trace.jsonc file to copy as cURL.",
        );
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "glubean.runPick",
      async (args: {
        filePath: string;
        testId: string;
        exportName: string;
        pickKey?: string;
      }) => {
        if (!args?.filePath) {
          vscode.window.showWarningMessage("No file specified for pick run.");
          return;
        }
        await testController.runWithPick(
          args.filePath,
          args.testId,
          args.pickKey,
        );
      },
    ),
  );

  // Log activation
  const outputChannel = vscode.window.createOutputChannel("Glubean");
  outputChannel.appendLine("Glubean extension activated");
  context.subscriptions.push(outputChannel);
}

export function deactivate(): void {
  // Nothing to clean up — VS Code disposes subscriptions automatically
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reuse an existing "Glubean" terminal or create a new one.
 */
function getOrCreateTerminal(): vscode.Terminal {
  const existing = vscode.window.terminals.find((t) => t.name === "Glubean");
  if (existing) {
    return existing;
  }
  return vscode.window.createTerminal("Glubean");
}
