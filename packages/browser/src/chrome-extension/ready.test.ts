import type { JSHandle, Page } from "puppeteer-core";
import { describe, expect, it, vi } from "vitest";
import { installExtensionReadyWatcher } from "./ready.js";

describe("installExtensionReadyWatcher", () => {
  it("returns the ready envelope rather than the predicate boolean", async () => {
    const envelope = { key: "__fixture", version: "1.0.0" };
    const dispose = vi.fn(async () => {});
    let predicate: ((markerName: string) => unknown) | undefined;
    const page = {
      evaluateOnNewDocument: vi.fn(async () => ({ identifier: "script-id" })),
      removeScriptToEvaluateOnNewDocument: vi.fn(async () => {}),
      evaluate: vi.fn(async () => {}),
      waitForFunction: vi.fn(async (candidate: (markerName: string) => unknown) => {
        predicate = candidate;
        return {
          jsonValue: async () => envelope,
          dispose,
        } as unknown as JSHandle;
      }),
    } as unknown as Page;

    const watcher = await installExtensionReadyWatcher(page, {
      keys: ["__fixture"],
    });
    expect(await watcher.wait()).toEqual(envelope);
    expect(predicate).toBeTypeOf("function");
    expect(dispose).toHaveBeenCalledOnce();
    await watcher.dispose();
    expect(page.removeScriptToEvaluateOnNewDocument).toHaveBeenCalledWith("script-id");
  });
});
