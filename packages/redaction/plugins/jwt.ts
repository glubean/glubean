/**
 * JWT plugin — detects JSON Web Tokens in string values.
 *
 * Matches the standard `header.payload.signature` format where
 * header and payload start with base64url-encoded `{"` (= `eyJ`).
 */

import type { RedactionPlugin } from "../types";

const JWT_SOURCE = "\\beyJ[a-zA-Z0-9_-]*\\.eyJ[a-zA-Z0-9_-]*\\.[a-zA-Z0-9_-]*";

export const jwtPlugin: RedactionPlugin = {
  name: "jwt",
  matchValue: () => new RegExp(JWT_SOURCE, "g"),
  partialMask: (match: string) => match.slice(0, 3) + "***" + match.slice(-3),
};
