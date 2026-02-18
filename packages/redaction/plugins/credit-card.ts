/**
 * Credit card plugin — detects 16-digit card numbers (with optional separators).
 */

import type { RedactionPlugin } from "../types.ts";

const CC_SOURCE = "\\b\\d{4}[- ]?\\d{4}[- ]?\\d{4}[- ]?\\d{4}\\b";

export const creditCardPlugin: RedactionPlugin = {
  name: "creditCard",
  matchValue: () => new RegExp(CC_SOURCE, "g"),
  partialMask: (match: string) => {
    // PCI standard: show only last 4 digits
    const digits = match.replace(/\D/g, "");
    const last4 = digits.slice(-4);
    return "****-****-****-" + last4;
  },
};
