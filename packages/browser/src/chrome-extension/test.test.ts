import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";
import { createExtensionTest } from "./test.js";
import type { ExtensionBrowser, ExtensionPage } from "./page.js";

const fixture = fileURLToPath(new URL("./fixtures/extension", import.meta.url));

describe("createExtensionTest", () => {
  it("creates a runnable browser test with a page fixture", () => {
    const setup = createExtensionTest({ extensions: fixture });

    expect(setup.test).toHaveProperty("extend");
    expect(setup.chrome).toBeDefined();
    expectTypeOf(setup.chrome).toEqualTypeOf<ExtensionBrowser>();

    setup.test({
      id: "extension-page-type-fixture",
      name: "The extension test fixture exposes extension-scoped page capabilities",
      tags: ["browser", "extension", "types"],
    }, async (ctx) => {
      expectTypeOf(ctx.page).toEqualTypeOf<ExtensionPage>();
    });
  });
});
