import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { BrowserPageClient } from "@glubean/browser";
import { isQaManagedBrowserClient, qaOpenCommand } from "./qa.js";

vi.mock("@glubean/runner", () => ({
  bootstrap: vi.fn(async () => {}),
}));

const minimalClient: BrowserPageClient = {
  newPage: async () => ({} as never),
};

describe("qa managed browser client detection", () => {
  it("rejects a page-only contract client", () => {
    expect(isQaManagedBrowserClient(minimalClient)).toBe(false);
  });

  it("accepts the managed lifecycle returned by browser({ launch: true })", () => {
    const managed = {
      ...minimalClient,
      isLaunched: true,
      wsEndpoint: async () => "ws://127.0.0.1/devtools/browser/test",
      close: async () => {},
    };

    expect(isQaManagedBrowserClient(managed)).toBe(true);
  });

  it("wires the guard into qa open before managed lifecycle methods are used", async () => {
    const directory = mkdtempSync(join(tmpdir(), "glubean-qa-client-"));
    const fixture = join(directory, "minimal.browser.mjs");
    writeFileSync(fixture, `
      export const journey = {
        _spec: {
          client: { newPage: async () => ({}) },
          cases: { minimal: { description: "minimal", steps: [] } },
        },
        _extracted: {
          id: "qa.minimal",
          protocol: "browser",
          cases: [{ key: "minimal", schemas: {} }],
        },
      };
    `);
    try {
      await expect(qaOpenCommand({
        file: fixture,
        case: "minimal",
        model: "test-model",
      })).rejects.toThrow(
        "contract client does not expose managed-browser lifecycle methods",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
