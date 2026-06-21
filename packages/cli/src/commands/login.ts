/**
 * glubean login — Authenticate with Glubean Cloud.
 */

import { input, password } from "@inquirer/prompts";
import { type AuthOptions, resolveApiUrl, writeCredentials } from "../lib/auth.js";

const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  yellow: "\x1b[33m",
};

export interface LoginOptions {
  token?: string;
  project?: string;
  apiUrl?: string;
}

export async function loginCommand(options: LoginOptions): Promise<void> {
  const apiUrl = await resolveApiUrl(options as AuthOptions);

  let token = options.token;
  if (!token) {
    const appUrl = apiUrl.replace("api.", "app.");
    console.log(
      `${colors.bold}Create a personal access token:${colors.reset}`,
    );
    console.log(
      `  ${colors.dim}${appUrl}/settings/tokens${colors.reset}`,
    );
    console.log(
      `  ${colors.dim}This token grants access to all your projects.${colors.reset}`,
    );
    console.log(
      `  ${colors.dim}For per-project tokens, use project settings → API keys.${colors.reset}`,
    );
    console.log();
    token = await password({
      message: "Paste your token (gb_...)",
      mask: "*",
    });
  }

  if (!token) {
    console.error(`${colors.red}Error: No token provided.${colors.reset}`);
    process.exit(1);
  }

  // Validate token via whoami
  console.log(`${colors.dim}Validating...${colors.reset}`);
  try {
    const resp = await fetch(`${apiUrl}/open/v1/whoami`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!resp.ok) {
      const body = await resp.text();
      console.error(
        `${colors.red}Authentication failed (${resp.status}): ${body}${colors.reset}`,
      );
      process.exit(1);
    }

    const whoami = await resp.json() as { kind: string; userId?: string; projectName?: string; projectId?: string };
    const identity = whoami.kind === "user"
      ? `user ${whoami.userId}`
      : `project ${whoami.projectName ?? whoami.projectId}`;

    console.log(`${colors.green}Authenticated as ${identity}${colors.reset}`);
  } catch (err) {
    console.error(
      `${colors.red}Failed to reach ${apiUrl}: ${err instanceof Error ? err.message : err}${colors.reset}`,
    );
    process.exit(1);
  }

  // Resolve project ID: flag → interactive prompt
  let projectId: string | undefined = options.project;
  if (!projectId) {
    projectId = await input({
      message: "Project ID (optional, from project settings)",
      default: "",
    });
    if (projectId === "") projectId = undefined;
  }

  const savedPath = await writeCredentials({
    token,
    projectId,
    apiUrl: apiUrl !== "https://api.glubean.com" ? apiUrl : undefined,
  });

  console.log(
    `${colors.green}Credentials saved${colors.reset} ${colors.dim}→ ${savedPath}${colors.reset}`,
  );
  if (projectId) {
    console.log(
      `${colors.dim}Default project: ${projectId}${colors.reset}`,
    );
  }
  // NOTE: this saves a personal `gb_` token for the legacy API. Cloud run
  // UPLOAD (`--upload`) targets the platform API, which accepts only `glb_`
  // PROJECT tokens — so don't advertise `glubean run --upload` here. Create a
  // project token in the dashboard (Project → Tokens) for uploads.
  console.log(
    `\n${colors.dim}To upload runs, create a project token (glb_…) in the dashboard (Project → Tokens) and set GLUBEAN_TOKEN.${colors.reset}`,
  );
}
