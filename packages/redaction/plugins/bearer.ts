/**
 * Bearer token plugin — detects "Bearer <token>" patterns.
 *
 * Common in Authorization headers and log messages.
 */

import type { RedactionPlugin } from "../types.ts";
import { genericPartialMask } from "../engine.ts";

const BEARER_SOURCE = "\\bBearer\\s+[a-zA-Z0-9._-]+";

export const bearerPlugin: RedactionPlugin = {
  name: "bearer",
  matchValue: () => new RegExp(BEARER_SOURCE, "gi"),
  partialMask: (match: string) => {
    if (match.toLowerCase().startsWith("bearer ")) {
      const token = match.slice(7);
      return "Bearer " + genericPartialMask(token);
    }
    return genericPartialMask(match);
  },
};
