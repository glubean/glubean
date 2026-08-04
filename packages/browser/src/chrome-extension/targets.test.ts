import type { Browser, Page, Target, WebWorker } from "puppeteer-core";
import { describe, expect, it } from "vitest";
import {
  extensionPageUrl,
  findExtensionTarget,
  listExtensionTargets,
  parseExtensionUrl,
  waitForExtensionPage,
  waitForExtensionWorker,
} from "./targets.js";

function target(
  url: string,
  type: string,
  options: { page?: Page; worker?: WebWorker } = {},
): Target {
  return {
    url: () => url,
    type: () => type,
    page: async () => options.page ?? null,
    worker: async () => options.worker ?? null,
  } as unknown as Target;
}

function browserWithTargets(targets: Target[]): Browser {
  return { targets: () => targets } as unknown as Browser;
}

describe("extension target helpers", () => {
  it("parses extension URLs and builds extension page URLs", () => {
    expect(parseExtensionUrl("chrome-extension://abc123/popup.html")).toEqual({
      id: "abc123",
      path: "popup.html",
    });
    expect(parseExtensionUrl("https://example.test")).toBeNull();
    expect(extensionPageUrl("abc123", "/popup.html")).toBe(
      "chrome-extension://abc123/popup.html",
    );
    expect(parseExtensionUrl(
      "chrome-extension://abc123/options.html?tab=privacy#/advanced",
    )).toEqual({ id: "abc123", path: "options.html" });
    expect(parseExtensionUrl(
      "chrome-extension://abc123/side%20panel-%E8%AF%AD%E8%A8%80.html",
    )).toEqual({ id: "abc123", path: "side panel-语言.html" });
  });

  it("lists only Chrome extension targets", () => {
    const extensionTarget = target(
      "chrome-extension://abc123/background.js",
      "service_worker",
    );
    const browser = browserWithTargets([
      extensionTarget,
      target("https://example.test/", "page"),
    ]);

    expect(listExtensionTargets(browser)).toMatchObject([{
      id: "abc123",
      path: "background.js",
      type: "service_worker",
    }]);
    expect(findExtensionTarget(browser, "abc123")?.target).toBe(extensionTarget);
  });

  it("returns a live worker", async () => {
    const worker = {} as WebWorker;
    const browser = browserWithTargets([
      target("chrome-extension://abc123/background.js", "service_worker", { worker }),
    ]);

    expect((await waitForExtensionWorker(browser, "abc123")).worker).toBe(worker);
  });

  it("accepts background-page and webview page target types", async () => {
    const page = {} as Page;
    const browser = browserWithTargets([
      target("chrome-extension://abc123/background.html", "background_page", { page }),
    ]);

    const result = await waitForExtensionPage(browser, {
      id: "abc123",
      path: "/background.html",
    });
    expect(result.type).toBe("background_page");
    expect(result.page).toBe(page);
  });

  it("matches manifest paths when the live page has query or hash state", async () => {
    const page = {} as Page;
    const browser = browserWithTargets([
      target("chrome-extension://abc123/sidepanel.html?tab=4#/", "page", { page }),
    ]);

    expect((await waitForExtensionPage(browser, {
      id: "abc123",
      path: "sidepanel.html",
    })).page).toBe(page);
  });
});
