/**
 * CodeLens provider for test.pick() example selection.
 *
 * Displays clickable buttons above test.pick() calls:
 * - When example keys are resolved: "Run (random) | key1 | key2 | key3"
 * - When keys cannot be resolved: a hint about the expected format
 *
 * Keys are resolved from:
 * 1. Inline object literals in the source code
 * 2. JSON import files (read from disk at render time)
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { extractPickExamples, isGlubeanFile, type PickMeta } from "./parser";

/**
 * Create a CodeLensProvider for test.pick() example buttons.
 *
 * @param runPickCommandId The command ID to execute when a CodeLens is clicked
 */
export function createPickCodeLensProvider(
  runPickCommandId: string
): vscode.CodeLensProvider {
  return new PickCodeLensProvider(runPickCommandId);
}

class PickCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  constructor(private readonly runPickCommandId: string) {
    // Refresh CodeLenses when documents are saved (keys may have changed)
    vscode.workspace.onDidSaveTextDocument(() => {
      this._onDidChangeCodeLenses.fire();
    });
  }

  provideCodeLenses(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken
  ): vscode.CodeLens[] {
    const content = document.getText();
    if (!isGlubeanFile(content)) {
      return [];
    }

    const pickMetas = extractPickExamples(content);
    if (pickMetas.length === 0) {
      return [];
    }

    const lenses: vscode.CodeLens[] = [];

    for (const meta of pickMetas) {
      // Resolve keys (may require reading JSON file from disk)
      const keys = this.resolveKeys(meta, document);
      const line = meta.line - 1; // 0-based for VS Code
      const range = new vscode.Range(line, 0, line, 0);

      if (keys && keys.length > 0) {
        // "Run (random)" button — no pick key, SDK picks randomly
        lenses.push(
          new vscode.CodeLens(range, {
            title: "\u25B6 Run (random)",
            command: this.runPickCommandId,
            arguments: [
              {
                filePath: document.uri.fsPath,
                testId: meta.testId,
                exportName: meta.exportName,
              },
            ],
          })
        );

        // One button per example key
        for (const key of keys) {
          lenses.push(
            new vscode.CodeLens(range, {
              title: `\u25B6 ${key}`,
              command: this.runPickCommandId,
              arguments: [
                {
                  filePath: document.uri.fsPath,
                  testId: meta.testId,
                  exportName: meta.exportName,
                  pickKey: key,
                },
              ],
            })
          );
        }
      } else {
        // Could not resolve keys — show format hint
        lenses.push(
          new vscode.CodeLens(range, {
            title:
              "test.pick: use inline object or JSON import for CodeLens buttons",
            command: "",
          })
        );

        // Still offer a "Run (random)" button
        lenses.push(
          new vscode.CodeLens(range, {
            title: "\u25B6 Run (random)",
            command: this.runPickCommandId,
            arguments: [
              {
                filePath: document.uri.fsPath,
                testId: meta.testId,
                exportName: meta.exportName,
              },
            ],
          })
        );
      }
    }

    return lenses;
  }

  /**
   * Resolve example keys for a PickMeta entry.
   *
   * - Inline keys: already extracted by the parser
   * - JSON import: read the file from disk and extract Object.keys()
   * - Unknown: return null
   */
  private resolveKeys(
    meta: PickMeta,
    document: vscode.TextDocument
  ): string[] | null {
    // Already resolved by parser (inline object literal)
    if (meta.keys) {
      return meta.keys;
    }

    // JSON import: read file and extract keys
    if (meta.dataSource?.type === "json-import") {
      return this.resolveJsonImportKeys(meta.dataSource.path, document);
    }

    return null;
  }

  /**
   * Read a JSON file and return its top-level keys.
   * Resolves the path relative to the document's directory.
   */
  private resolveJsonImportKeys(
    jsonPath: string,
    document: vscode.TextDocument
  ): string[] | null {
    try {
      // Resolve relative path against the document's directory
      const docDir = path.dirname(document.uri.fsPath);
      const resolvedPath = path.resolve(docDir, jsonPath);

      const content = fs.readFileSync(resolvedPath, "utf-8");
      const data = JSON.parse(content);

      if (data && typeof data === "object" && !Array.isArray(data)) {
        return Object.keys(data);
      }

      // JSON root is not an object (e.g. array) — can't extract named keys
      return null;
    } catch {
      // File not found, parse error, etc.
      return null;
    }
  }
}
