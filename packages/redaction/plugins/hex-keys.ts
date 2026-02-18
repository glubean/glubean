/**
 * Hex keys plugin — detects long hex strings (32+ chars) that are
 * likely API keys, hashes, or secrets.
 */

import type { RedactionPlugin } from "../types.ts";
import { genericPartialMask } from "../engine.ts";

const HEX_SOURCE = "\\b[a-f0-9]{32,}\\b";

export const hexKeysPlugin: RedactionPlugin = {
  name: "hexKeys",
  matchValue: () => new RegExp(HEX_SOURCE, "gi"),
  partialMask: genericPartialMask,
};
