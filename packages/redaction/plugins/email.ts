/**
 * Email plugin — detects standard email addresses.
 */

import type { RedactionPlugin } from "../types.ts";

const EMAIL_SOURCE = "\\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}\\b";

export const emailPlugin: RedactionPlugin = {
  name: "email",
  matchValue: () => new RegExp(EMAIL_SOURCE, "g"),
  partialMask: (match: string) => {
    // u***@***.com
    const atIdx = match.indexOf("@");
    if (atIdx <= 0) return "***@***";
    const dotIdx = match.lastIndexOf(".");
    const user = match.slice(0, atIdx);
    const domainSuffix = dotIdx > atIdx ? match.slice(dotIdx) : "";
    return user[0] + "***@***" + domainSuffix;
  },
};
