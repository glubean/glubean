import { redactValue, BUILTIN_SCOPES } from "@glubean/redaction";
import type { RedactionConfig } from "@glubean/redaction";
import type { UploadResultPayload } from "./upload.js";

type UploadMetadata = NonNullable<UploadResultPayload["metadata"]>;

/**
 * Union of every sensitive key declared across the built-in event scopes
 * (e.g. `authorization`, `cookie`, `set-cookie`, `x-api-key`). The metadata
 * projection has no single event type to scope by, so we apply ALL of them
 * (plus the built-in baseline, enabled inside `redactValue`) — ensuring the
 * projection is redacted at least as strongly as the events it accompanies.
 */
const SCOPE_SENSITIVE_KEYS: string[] = [
  ...new Set(BUILTIN_SCOPES.flatMap((s) => s.rules?.sensitiveKeys ?? [])),
];

/**
 * Deep-redact the FULL contract/workflow projection buckets of an upload
 * metadata object before it leaves the machine.
 *
 * Only `contractsProjection` and `workflows` are redacted — they are free-form
 * trees that can carry secrets at any path (examples, default headers, gRPC
 * metadata, `extensions`/`meta` blobs, literal compare/switch values, assertion
 * messages). Everything else is returned untouched; in particular
 * `files[].hash` / `rootHash` MUST survive verbatim, since the `hexKeys`
 * pattern would otherwise mangle their sha256 hex and corrupt the server's
 * test registry + dedup.
 *
 * Returns a new object when redaction applies; the input is never mutated.
 * When neither projection bucket is present the input is returned as-is.
 * A generous `maxDepth` keeps nested JSON Schemas / recursive workflow branch
 * trees from truncating to a `[REDACTED: too deep]` sentinel.
 *
 * Redaction model (same engine as event redaction, config-driven):
 *  - Only SCALARS (string/number) are ever masked. A sensitive key over an
 *    object/array is RECURSED into, never replaced wholesale — so JSON-Schema
 *    nodes (`properties.password = { type: "string" }`) keep their shape.
 *  - A scalar is masked when its own key is sensitive (built-in baseline +
 *    scope keys + the project's `globalRules.sensitiveKeys`) OR its value
 *    matches a value pattern (jwt/bearer/email/…).
 *  - BOUNDARY: a secret nested under a sensitive key but keyed by a
 *    NON-sensitive inner name (e.g. `authorization: { value: "sk_live…" }`)
 *    is NOT auto-masked. That is by design — like events, such project-specific
 *    shapes are declared in the redaction config (`sensitiveKeys` /
 *    `customPatterns`), not hard-coded here. In practice nested secrets
 *    usually sit under a sensitive inner key (`token`/`password`/`secret`)
 *    and ARE caught.
 */
export function redactMetadataForUpload(
  metadata: UploadMetadata,
  redaction: Pick<RedactionConfig, "globalRules" | "replacementFormat">,
): UploadMetadata {
  if (!metadata.contractsProjection && !metadata.workflows) return metadata;

  const redact = (v: unknown): unknown =>
    redactValue(v, {
      globalRules: redaction.globalRules,
      // Built-in baseline (password/token/authorization/…) is enabled by
      // default inside redactValue; add the scope-declared keys on top so a
      // default config (empty globalRules.sensitiveKeys) still masks
      // key-based secrets the value patterns would miss.
      sensitiveKeys: SCOPE_SENSITIVE_KEYS,
      replacementFormat: redaction.replacementFormat,
      maxDepth: 64,
    });

  return {
    ...metadata,
    ...(metadata.contractsProjection
      ? { contractsProjection: redact(metadata.contractsProjection) as unknown[] }
      : {}),
    ...(metadata.workflows ? { workflows: redact(metadata.workflows) as unknown[] } : {}),
  };
}
