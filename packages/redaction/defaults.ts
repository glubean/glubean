/**
 * @module defaults
 *
 * Built-in sensitive keys, pattern source strings, and the default
 * redaction configuration used as the mandatory baseline for --share.
 */

import type { RedactionConfig } from "./types.ts";

// ── Built-in sensitive keys ─────────────────────────────────────────────────

/**
 * Keys whose values are always redacted when matched (case-insensitive
 * substring match). Ported from glubean-v1 RedactionService for parity.
 */
export const BUILT_IN_SENSITIVE_KEYS: readonly string[] = [
  "password",
  "passwd",
  "secret",
  "token",
  "api_key",
  "apikey",
  "api-key",
  "access_token",
  "refresh_token",
  "authorization",
  "auth",
  "credential",
  "credentials",
  "private_key",
  "privatekey",
  "private-key",
  "ssh_key",
  "client_secret",
  "client-secret",
  "bearer",
];

// ── Built-in pattern source strings ─────────────────────────────────────────

/**
 * Regex source strings for built-in value-level patterns.
 * Plugins create new RegExp instances from these on each call
 * to avoid stale lastIndex state.
 */
export const PATTERN_SOURCES: Record<
  string,
  { source: string; flags: string }
> = {
  jwt: {
    source: "\\beyJ[a-zA-Z0-9_-]*\\.eyJ[a-zA-Z0-9_-]*\\.[a-zA-Z0-9_-]*",
    flags: "g",
  },
  bearer: {
    source: "\\bBearer\\s+[a-zA-Z0-9._-]+",
    flags: "gi",
  },
  awsKeys: {
    source: "\\bAKIA[0-9A-Z]{16}\\b",
    flags: "g",
  },
  githubTokens: {
    source: "\\b(ghp_|gho_|ghu_|ghs_|ghr_)[a-zA-Z0-9]{36,}\\b",
    flags: "g",
  },
  email: {
    source: "\\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}\\b",
    flags: "g",
  },
  ipAddress: {
    source: "\\b\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\b",
    flags: "g",
  },
  creditCard: {
    source: "\\b\\d{4}[- ]?\\d{4}[- ]?\\d{4}[- ]?\\d{4}\\b",
    flags: "g",
  },
  hexKeys: {
    source: "\\b[a-f0-9]{32,}\\b",
    flags: "gi",
  },
};

// ── Default config ──────────────────────────────────────────────────────────

/**
 * The mandatory baseline configuration for --share.
 *
 * All scopes on, all patterns on, useBuiltIn keys, simple replacement.
 * User .glubean/redact.json can only add rules on top — never weaken this.
 */
export const DEFAULT_CONFIG: RedactionConfig = {
  scopes: {
    requestHeaders: true,
    requestQuery: true,
    requestBody: true,
    responseHeaders: true,
    responseBody: true,
    consoleOutput: true,
    errorMessages: true,
    returnState: true,
  },
  sensitiveKeys: {
    useBuiltIn: true,
    additional: [],
    excluded: [],
  },
  patterns: {
    jwt: true,
    bearer: true,
    awsKeys: true,
    githubTokens: true,
    email: true,
    ipAddress: true,
    creditCard: true,
    hexKeys: true,
    custom: [],
  },
  replacementFormat: "simple",
};
