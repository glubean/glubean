/**
 * Shared constants for the Glubean CLI.
 */

/** Last-resort default Glubean API URL — used only once every other source
 *  in resolveApiUrl's precedence chain (--api-url flag, GLUBEAN_PLATFORM_API_URL
 *  / GLUBEAN_API_URL env or .env file (auto-derived to the platform.* host —
 *  see resolveApiUrl in ./auth.ts), package.json glubean.cloud.apiUrl,
 *  ~/.glubean/credentials.json) comes up empty. This is the PLATFORM API
 *  (run/load/sync ingest, token-only `/v1/*`) — a SEPARATE Cloud Run service
 *  from `api.glubean.com` (server-hono, the Dashboard/session host, which
 *  404s on `/v1/*`). Verified live: `platform.glubean.com` is the real,
 *  working domain mapping onto `glubean-platform-api-prod` (GLU-161 follow-up). */
export const DEFAULT_API_URL = "https://platform.glubean.com";

/** Default Glubean AUTH URL (server-hono: better-auth + the `glubean login`
 *  device grant). Separate plane from the platform API — locally set
 *  GLUBEAN_AUTH_URL=https://api.glubean.test. */
export const DEFAULT_AUTH_URL = "https://api.glubean.com";
