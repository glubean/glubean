/**
 * AWS access key plugin — detects AKIA-prefixed access key IDs.
 */

import type { RedactionPlugin } from "../types.ts";

const AWS_SOURCE = "\\bAKIA[0-9A-Z]{16}\\b";

export const awsKeysPlugin: RedactionPlugin = {
  name: "awsKeys",
  matchValue: () => new RegExp(AWS_SOURCE, "g"),
  // AKIA prefix is meaningful, show first 4 + last 2
  partialMask: (match: string) => match.slice(0, 4) + "***" + match.slice(-2),
};
