/**
 * glubean login — Sign the CLI in to Glubean Cloud via the device-authorization
 * grant (RFC 8628). The CLI requests a code from the AUTH plane (server-hono),
 * opens the browser to approve it, polls until a `glb_` token is minted, and
 * saves it to ~/.glubean/credentials.json for `--upload`.
 *
 * Login talks to the AUTH url (server-hono); uploads talk to the platform API
 * (`GLUBEAN_API_URL`) — two separate planes. The open platform is token-only and
 * has no login of its own.
 */

import { execFile } from "node:child_process";
import {
  type AuthOptions,
  resolveApiUrl,
  resolveAuthUrl,
  writeCredentials,
} from "../lib/auth.js";
import { DEFAULT_API_URL, DEFAULT_AUTH_URL } from "../lib/constants.js";

const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

export interface LoginOptions {
  /** Non-interactive escape hatch: save this glb_ token directly (no device flow). */
  token?: string;
  project?: string;
  /** Platform/upload API URL to persist for `--upload`. */
  apiUrl?: string;
  /** Auth-plane URL (server-hono) for the device grant. */
  authUrl?: string;
  /** Don't auto-open the browser (print the URL only). */
  noBrowser?: boolean;
}

type DeviceGrant = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  interval: number;
  expires_in: number;
};

type DevicePoll =
  | { status: "pending" }
  | { status: "approved"; token: string; projectId?: string }
  | { status: "denied" }
  | { status: "expired" };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Best-effort: open a URL in the default browser. Failures are ignored — the
 *  CLI always prints the URL so the user can open it manually. */
function openBrowser(url: string): void {
  try {
    if (process.platform === "darwin") {
      execFile("open", [url]);
    } else if (process.platform === "win32") {
      execFile("cmd", ["/c", "start", "", url]);
    } else {
      execFile("xdg-open", [url]);
    }
  } catch {
    // ignored — the URL is printed regardless
  }
}

async function persist(
  token: string,
  options: LoginOptions,
  apiUrl: string,
  authUrl: string,
  defaultProject?: string,
): Promise<void> {
  // --project wins; otherwise persist the project the grant bound the token to
  // (the org's default), so `glubean run --upload` works without --project.
  const projectId = options.project ?? defaultProject;
  const savedPath = await writeCredentials({
    token,
    projectId,
    apiUrl: apiUrl !== DEFAULT_API_URL ? apiUrl : undefined,
    authUrl: authUrl !== DEFAULT_AUTH_URL ? authUrl : undefined,
  });
  console.log(
    `${colors.green}Logged in${colors.reset} ${colors.dim}→ credentials saved to ${savedPath}${colors.reset}`,
  );
  if (projectId) {
    console.log(`${colors.dim}Default project: ${projectId}${colors.reset}`);
    console.log(`\n${colors.dim}Run tests and upload: glubean run --upload${colors.reset}`);
  } else {
    console.log(
      `\n${colors.dim}Run tests and upload: glubean run --upload --project <id> (or set GLUBEAN_PROJECT_ID).${colors.reset}`,
    );
  }
}

export async function loginCommand(options: LoginOptions): Promise<void> {
  const authUrl = (await resolveAuthUrl(options as AuthOptions)).replace(/\/+$/, "");
  const apiUrl = await resolveApiUrl(options as AuthOptions);

  // Non-interactive escape hatch: persist a token the user already created in the
  // dashboard (Project → Tokens). The upload preflight validates it later.
  if (options.token) {
    await persist(options.token, options, apiUrl, authUrl);
    return;
  }

  // 1) Start the device grant.
  let grant: DeviceGrant;
  try {
    const resp = await fetch(`${authUrl}/cli/device/code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    if (!resp.ok) {
      console.error(
        `${colors.red}Could not start login (${resp.status}) at ${authUrl}.${colors.reset}`,
      );
      console.error(
        `${colors.dim}Check --auth-url / GLUBEAN_AUTH_URL points at the Glubean auth server.${colors.reset}`,
      );
      process.exit(1);
    }
    grant = (await resp.json()) as DeviceGrant;
  } catch (err) {
    console.error(
      `${colors.red}Cannot reach ${authUrl}: ${err instanceof Error ? err.message : err}${colors.reset}`,
    );
    process.exit(1);
  }

  // 2) Show the code + open the browser.
  const openUrl = grant.verification_uri_complete ?? grant.verification_uri;
  console.log(`\n${colors.bold}Authorize the Glubean CLI${colors.reset}`);
  console.log(`  ${colors.dim}Open:${colors.reset} ${colors.cyan}${grant.verification_uri}${colors.reset}`);
  console.log(`  ${colors.dim}Code:${colors.reset} ${colors.bold}${grant.user_code}${colors.reset}\n`);
  if (options.noBrowser) {
    console.log(`${colors.dim}Open the URL above and enter the code.${colors.reset}`);
  } else {
    console.log(`${colors.dim}Opening your browser…${colors.reset}`);
    openBrowser(openUrl);
  }

  // 3) Poll until approved / denied / expired (or the grant times out).
  const intervalMs = Math.max(1, grant.interval) * 1000;
  const deadline = Date.now() + Math.max(1, grant.expires_in) * 1000;
  console.log(`${colors.dim}Waiting for approval…${colors.reset}`);
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    let poll: DevicePoll;
    try {
      const resp = await fetch(`${authUrl}/cli/device/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_code: grant.device_code }),
      });
      if (!resp.ok) continue; // transient — keep polling
      poll = (await resp.json()) as DevicePoll;
    } catch {
      continue; // transient network blip — keep polling
    }
    if (poll.status === "approved" && poll.token) {
      await persist(poll.token, options, apiUrl, authUrl, poll.projectId);
      return;
    }
    if (poll.status === "denied") {
      console.error(`${colors.red}Login denied in the browser.${colors.reset}`);
      process.exit(1);
    }
    if (poll.status === "expired") {
      console.error(`${colors.red}The login code expired. Run 'glubean login' again.${colors.reset}`);
      process.exit(1);
    }
  }
  console.error(`${colors.red}Timed out waiting for approval. Run 'glubean login' again.${colors.reset}`);
  process.exit(1);
}
