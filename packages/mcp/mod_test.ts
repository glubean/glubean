import { assertEquals } from "@std/assert";
import denoJson from "./deno.json" with { type: "json" };
import { DEFAULT_GENERATED_BY, MCP_PACKAGE_VERSION } from "./mod.ts";

Deno.test("mcp runtime version constants align with package version", () => {
  assertEquals(MCP_PACKAGE_VERSION, denoJson.version);
  assertEquals(DEFAULT_GENERATED_BY, `@glubean/mcp@${denoJson.version}`);
});
