import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extensionLaunchOptions } from "./launch.js";

const fixture = fileURLToPath(new URL("./fixtures/extension", import.meta.url));

describe("extensionLaunchOptions", () => {
  it("loads unpacked extensions and defaults to visible Chrome", () => {
    expect(extensionLaunchOptions(fixture, {
      userDataDir: ".tmp/extension-profile",
    })).toMatchObject({
      headless: false,
      pipe: true,
      userDataDir: ".tmp/extension-profile",
      enableExtensions: [fixture],
    });
  });

  it("allows an explicit headless mode", () => {
    expect(extensionLaunchOptions(fixture, { headless: true }).headless).toBe(true);
  });

  it("rejects an incompatible pipe mode", () => {
    expect(() => extensionLaunchOptions(fixture, { pipe: false })).toThrow(
      "requires pipe: true",
    );
  });

  it("rejects caller-owned remote debugging args", () => {
    expect(() => extensionLaunchOptions(fixture, {
      args: ["--remote-debugging-port=9222"],
    })).toThrow("Puppeteer owns the required pipe transport");
  });
});
