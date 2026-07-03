/**
 * Shared constants for the Glubean CLI.
 */

/** Last-resort default Glubean API URL — used only once every other source
 *  in resolveApiUrl's precedence chain (--api-url flag, GLUBEAN_PLATFORM_API_URL
 *  / GLUBEAN_API_URL env or .env file, package.json glubean.cloud.apiUrl,
 *  ~/.glubean/credentials.json) comes up empty. This is the PLATFORM API
 *  (run/load/sync ingest, token-only `/v1/*`) — see resolveApiUrl in
 *  ./auth.ts for the full precedence (GLU-161). */
export const DEFAULT_API_URL = "https://api.glubean.com";

/** Default Glubean AUTH URL (server-hono: better-auth + the `glubean login`
 *  device grant). Separate plane from the platform API — locally set
 *  GLUBEAN_AUTH_URL=https://api.glubean.test. */
export const DEFAULT_AUTH_URL = "https://api.glubean.com";
