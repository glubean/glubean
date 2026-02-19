import denoJson from "./deno.json" with { type: "json" };

export const MCP_PACKAGE_VERSION = denoJson.version;
export const DEFAULT_GENERATED_BY = `@glubean/mcp@${MCP_PACKAGE_VERSION}`;
