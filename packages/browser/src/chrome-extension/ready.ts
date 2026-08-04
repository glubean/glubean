import type { Page } from "puppeteer-core";

export interface ExtensionReadyEvent {
  key: string;
  version?: string;
}

export interface ExtensionReadyWatcher {
  wait(): Promise<ExtensionReadyEvent>;
  dispose(): Promise<void>;
}

/**
 * Install a watcher before navigation and wait for a top-level content script
 * to post `{ [key]: "ready", version?: string }` into its matching page.
 * Call `dispose()` when the watcher is no longer needed.
 */
export async function installExtensionReadyWatcher(
  page: Page,
  options: { keys?: readonly string[]; timeout?: number } = {},
): Promise<ExtensionReadyWatcher> {
  const keys = options.keys ?? ["__glubean"];
  if (keys.length === 0) throw new Error("At least one extension ready key is required.");

  const marker = `__glubeanExtensionReady_${Math.random().toString(36).slice(2)}`;
  const script = await page.evaluateOnNewDocument(
    (markerName: string, readyKeys: readonly string[]) => {
      const listenerKey = `${markerName}_listener`;
      const listener = (event: MessageEvent) => {
        if (event.source !== window || !event.data || typeof event.data !== "object") return;
        const data = event.data as Record<string, unknown>;
        const key = readyKeys.find((candidate) => data[candidate] === "ready");
        if (!key) return;
        const record = globalThis as typeof globalThis & Record<string, unknown>;
        record[markerName] = {
          key,
          version: typeof data.version === "string" ? data.version : undefined,
        };
      };
      const record = globalThis as typeof globalThis & Record<string, unknown>;
      record[listenerKey] = listener;
      window.addEventListener("message", listener);
    },
    marker,
    keys,
  );

  return {
    async wait(): Promise<ExtensionReadyEvent> {
      const handle = await page.waitForFunction(
        (markerName: string) =>
          (globalThis as Record<string, unknown>)[markerName] ?? false,
        { timeout: options.timeout ?? 10_000 },
        marker,
      );
      try {
        return await handle.jsonValue() as unknown as ExtensionReadyEvent;
      } finally {
        await handle.dispose();
      }
    },
    async dispose(): Promise<void> {
      try {
        await page.removeScriptToEvaluateOnNewDocument(script.identifier);
      } catch {
        // The page may already be closed.
      }
      try {
        await page.evaluate((markerName: string) => {
          const record = globalThis as typeof globalThis & Record<string, unknown>;
          const listenerKey = `${markerName}_listener`;
          const listener = record[listenerKey];
          if (typeof listener === "function") {
            window.removeEventListener("message", listener as EventListener);
          }
          delete record[listenerKey];
          delete record[markerName];
        }, marker);
      } catch {
        // The page may have closed or navigated while cleanup was requested.
      }
    },
  };
}
