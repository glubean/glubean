import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createExtensionTest } from "./test.js";

const fixture = fileURLToPath(new URL("./fixtures/extension", import.meta.url));

describe("createExtensionTest", () => {
  it("creates a runnable browser test with a page fixture", () => {
    const setup = createExtensionTest({ extensions: fixture });

    expect(setup.test).toHaveProperty("extend");
    expect(setup.chrome).toBeDefined();
  });
});
