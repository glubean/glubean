/**
 * GitHub token plugin — detects ghp_, gho_, ghu_, ghs_, ghr_ prefixed tokens.
 */

import type { RedactionPlugin } from "../types";

const GITHUB_SOURCE = "\\b(ghp_|gho_|ghu_|ghs_|ghr_)[a-zA-Z0-9]{36,}\\b";

export const githubTokensPlugin: RedactionPlugin = {
  name: "githubTokens",
  matchValue: () => new RegExp(GITHUB_SOURCE, "g"),
  partialMask: (match: string) => {
    // ghp_ prefix is meaningful, show prefix + last 3
    const prefixEnd = match.indexOf("_");
    if (prefixEnd > 0 && prefixEnd < 4) {
      return match.slice(0, prefixEnd + 1) + "***" + match.slice(-3);
    }
    return match.slice(0, 4) + "***" + match.slice(-3);
  },
};
