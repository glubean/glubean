/**
 * glubean login — Save a Glubean Cloud project token for CLI uploads.
 *
 * The platform API (run/load ingest) authenticates with `glb_` PROJECT tokens
 * created in the dashboard (Project → Tokens) — there is no programmatic CLI
 * mint (token creation is session-only; a token can't mint tokens). So login is
 * "paste your project token": validate it against the platform API and save it
 * to ~/.glubean/credentials.json for `--upload`.
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
  const appUrl = apiUrl.replace(/(^https?:\/\/)api\./i, "$1app.");

  let token = options.token;
  if (!token) {
    console.log(`${colors.bold}Create a project token (glb_…):${colors.reset}`);
    console.log(`  ${colors.dim}${appUrl} → Project → Tokens${colors.reset}`);
    console.log(
      `  ${colors.dim}Tokens are created in the dashboard; the CLI just saves one for uploads.${colors.reset}`,
    );
    console.log();
    token = await password({
      message: "Paste your project token (glb_...)",
      mask: "*",
    });
  }

  if (!token) {
    console.error(`${colors.red}Error: No token provided.${colors.reset}`);
    process.exit(1);
  }

  // Validate against the SAME platform API uploads use, by listing the projects
  // the token can reach. 401 → invalid/expired or not a glb_ token (fatal). 200
  // → valid; show the reachable projects (a non-array body means --api-url isn't
  // the platform API → fatal). 403 → only a missing READ scope
  // (`insufficient_scope`) is accepted (the token can still write runs); other
  // 403s (e.g. `no_membership`) mean it can't upload either → fatal. This
  // mirrors the upload preflight so login never saves a token uploads reject.
  //
  // LIMIT: this verifies the token authenticates + has org access, NOT that it
  // carries `runs:write` — the platform API has no token-scope introspection
  // endpoint, and the ingest is a side-effecting POST we won't fire just to
  // probe. A token missing `runs:write` is caught at upload time (403). The
  // upload preflight has the same boundary.
  console.log(`${colors.dim}Validating…${colors.reset}`);
  let projects: Array<{ id?: string; name?: string }> = [];
  try {
    const resp = await fetch(`${apiUrl}/v1/projects`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (resp.status === 401) {
      console.error(`${colors.red}Authentication failed (401).${colors.reset}`);
      console.error(
        `${colors.dim}The token is invalid/expired or not a platform project token (glb_…). Create one in the dashboard (${appUrl} → Project → Tokens).${colors.reset}`,
      );
      process.exit(1);
    } else if (resp.ok) {
      const body = await resp.json().catch(() => null);
      if (!Array.isArray(body)) {
        console.error(`${colors.red}Unexpected response from ${apiUrl}.${colors.reset}`);
        console.error(
          `${colors.dim}Check that --api-url / GLUBEAN_API_URL points at the Glubean platform API.${colors.reset}`,
        );
        process.exit(1);
      }
      projects = body as Array<{ id?: string; name?: string }>;
      const label =
        projects.length === 0
          ? "no projects yet"
          : projects.map((p) => p.name ?? p.id).filter(Boolean).join(", ");
      console.log(`${colors.green}Token valid${colors.reset} ${colors.dim}(${label})${colors.reset}`);
    } else if (resp.status === 403) {
      const body = (await resp.json().catch(() => ({}))) as { error?: unknown };
      if (body.error === "insufficient_scope") {
        console.log(
          `${colors.green}Token valid${colors.reset} ${colors.dim}(limited scope — can't list projects; uploads still work)${colors.reset}`,
        );
      } else {
        console.error(`${colors.red}Access forbidden (403).${colors.reset}`);
        console.error(
          `${colors.dim}The token's org has no access (or its membership was revoked) — it can't upload runs. Use a token whose org owns the project.${colors.reset}`,
        );
        process.exit(1);
      }
    } else {
      console.error(`${colors.red}Validation failed (${resp.status}).${colors.reset}`);
      console.error(
        `${colors.dim}Check that --api-url / GLUBEAN_API_URL points at the Glubean platform API.${colors.reset}`,
      );
      process.exit(1);
    }
  } catch (err) {
    console.error(
      `${colors.red}Failed to reach ${apiUrl}: ${err instanceof Error ? err.message : err}${colors.reset}`,
    );
    process.exit(1);
  }

  // Resolve a default project id: flag → single reachable project → prompt.
  let projectId: string | undefined = options.project;
  if (!projectId && projects.length === 1 && projects[0].id) {
    projectId = projects[0].id;
  }
  if (!projectId) {
    const answer = await input({
      message: "Default project id (optional)",
      default: "",
    });
    projectId = answer.trim() === "" ? undefined : answer.trim();
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
    console.log(`${colors.dim}Default project: ${projectId}${colors.reset}`);
    console.log(`\n${colors.dim}Run tests and upload: glubean run --upload${colors.reset}`);
  } else {
    // No default project saved — `--upload` needs one, so spell it out rather
    // than print a command that would exit with "requires a project ID".
    console.log(
      `\n${colors.dim}Run tests and upload: glubean run --upload --project <id> (or set GLUBEAN_PROJECT_ID).${colors.reset}`,
    );
  }
}
