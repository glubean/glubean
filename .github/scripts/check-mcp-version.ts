import denoJson from "../../packages/mcp/deno.json" with { type: "json" };
import {
  DEFAULT_GENERATED_BY,
  MCP_PACKAGE_VERSION,
} from "../../packages/mcp/version.ts";

if (MCP_PACKAGE_VERSION !== denoJson.version) {
  console.error(
    `MCP_PACKAGE_VERSION mismatch: ${MCP_PACKAGE_VERSION} != ${denoJson.version}`,
  );
  Deno.exit(1);
}

const expectedGeneratedBy = `@glubean/mcp@${denoJson.version}`;
if (DEFAULT_GENERATED_BY !== expectedGeneratedBy) {
  console.error(
    `DEFAULT_GENERATED_BY mismatch: ${DEFAULT_GENERATED_BY} != ${expectedGeneratedBy}`,
  );
  Deno.exit(1);
}

console.log("✓ MCP runtime metadata version aligned");
