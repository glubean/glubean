/**
 * Shared constants for the Glubean CLI.
 */

/** Default Glubean API URL used when neither --api-url nor GLUBEAN_API_URL is set.
 *  This is the PLATFORM API (run/load ingest, token-only `/v1/*`). */
export const DEFAULT_API_URL = "https://api.glubean.com";

/** Default Glubean AUTH URL (server-hono: better-auth + the `glubean login`
 *  device grant). Separate plane from the platform API — locally set
 *  GLUBEAN_AUTH_URL=https://api.glubean.test. */
export const DEFAULT_AUTH_URL = "https://api.glubean.com";
