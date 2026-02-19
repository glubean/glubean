import denoConfig from "./deno.json" with { type: "json" };

export const CLI_VERSION: string = denoConfig.version;
