/**
 * IP address plugin — detects IPv4 addresses.
 */

import type { RedactionPlugin } from "../types.ts";
import { genericPartialMask } from "../engine.ts";

const IP_SOURCE = "\\b\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\b";

export const ipAddressPlugin: RedactionPlugin = {
  name: "ipAddress",
  matchValue: () => new RegExp(IP_SOURCE, "g"),
  partialMask: (match: string) => {
    // Show first two octets: 192.168.*.*
    const parts = match.split(".");
    if (parts.length === 4) {
      return parts[0] + "." + parts[1] + ".*.*";
    }
    return genericPartialMask(match);
  },
};
