import { describe, expect, it } from "vitest";
import type { Browser } from "puppeteer-core";
import { GlubeanBrowser, resolveNavigationUrl } from "./page.js";

describe("extension-origin navigation", () => {
  it("does not prepend baseUrl to chrome-extension URLs", () => {
    expect(resolveNavigationUrl(
      "chrome-extension://abc123/options.html",
      "https://app.example.test",
    )).toBe(
      "chrome-extension://abc123/options.html",
    );
    expect(resolveNavigationUrl("/dashboard", "https://app.example.test")).toBe(
      "https://app.example.test/dashboard",
    );
    expect(resolveNavigationUrl(
      "data:text/plain,hello",
      "https://app.example.test",
    )).toBe(
      "https://app.example.test/data:text/plain,hello",
    );
  });

  it("rejects attach requests for pipe-transport Chrome sessions", async () => {
    const raw = { wsEndpoint: () => "" } as unknown as Browser;
    const chrome = new GlubeanBrowser(async () => raw, undefined, { launch: true });

    await expect(chrome.wsEndpoint()).rejects.toThrow(
      "pipe transport and has no CDP WebSocket endpoint",
    );
  });
});
