/**
 * Markdown rendering for HTTP contracts.
 *
 * **P2 stub** — full logic to be migrated from
 * `packages/cli/src/commands/contracts.ts` in P4.
 */

import type { ExtractedContractProjection } from "../contract-types.js";
import type { HttpContractMeta, HttpSafeSchemas } from "./types.js";

export function renderMarkdownForHttp(
  projection: ExtractedContractProjection<HttpSafeSchemas, HttpContractMeta>,
): string {
  const lines: string[] = [];
  lines.push(`## ${projection.id} (${projection.target})`);
  if (projection.description) lines.push(projection.description);
  lines.push("");
  lines.push("### Cases");
  for (const c of projection.cases) {
    const status = c.schemas?.response?.status ?? "?";
    const suffix = c.lifecycle !== "active" ? ` [${c.lifecycle}]` : "";
    lines.push(`- **${c.key}** (${status})${suffix} — ${c.description ?? ""}`);
  }
  return lines.join("\n");
}
