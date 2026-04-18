/**
 * OpenAPI generation for HTTP contracts.
 *
 * **P2 stub** — full logic will be migrated here from
 * `packages/mcp/src/index.ts` L1445–L1700 in P4. At that point MCP's
 * `glubean_openapi` tool will call `adapter.toOpenApi(extracted)` instead
 * of inlining HTTP-specific logic.
 *
 * For now the stub returns a minimal OpenAPI fragment so adapter.toOpenApi
 * is wired end-to-end and tests don't throw.
 */

import type {
  ExtractedContractProjection,
} from "../contract-types.js";
import type { HttpContractMeta, HttpSafeSchemas } from "./types.js";

export function buildOpenApiForHttp(
  projection: ExtractedContractProjection<HttpSafeSchemas, HttpContractMeta>,
): Record<string, unknown> | undefined {
  // Stub: minimal path entry. Replaced with full implementation in P4.
  const method = (projection.meta?.method ?? "GET").toLowerCase();
  const path = projection.meta?.path ?? projection.target;

  const operation: Record<string, unknown> = {
    summary: projection.description,
    operationId: projection.id,
  };

  const responses: Record<string, unknown> = {};
  for (const c of projection.cases) {
    const status = String(c.schemas?.response?.status ?? 200);
    if (!responses[status]) {
      responses[status] = {
        description: c.description ?? "",
      };
    }
  }
  operation.responses = responses;

  return {
    paths: {
      [path]: {
        [method]: operation,
      },
    },
  };
}
