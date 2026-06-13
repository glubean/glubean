import { test, expect, describe } from "vitest";
import { DEFAULT_GLOBAL_RULES } from "@glubean/redaction";
import { redactMetadataForUpload } from "./redact-metadata.js";

type UploadMetadata = Parameters<typeof redactMetadataForUpload>[0];

const REDACTION = {
  globalRules: { ...DEFAULT_GLOBAL_RULES, sensitiveKeys: ["authorization", "apiKey"] },
  replacementFormat: "simple" as const,
};

function baseMetadata(): UploadMetadata {
  return {
    schemaVersion: "1",
    generatedBy: "test",
    generatedAt: "2026-06-08T00:00:00.000Z",
    testCount: 0,
    fileCount: 1,
    tags: [],
    // sha256 hex — the hexKeys pattern would mangle this if redaction
    // touched it. It MUST survive verbatim.
    files: {
      "users.contract.ts": {
        hash: "sha256-" + "a".repeat(64),
        exports: [],
      },
    },
  };
}

describe("redactMetadataForUpload", () => {
  test("redacts key-based secrets under the DEFAULT config (codex P1 regression)", () => {
    // The default redaction config has empty globalRules.sensitiveKeys — the
    // built-in keys live in event scopes. A projection carrying
    // `{ authorization: "sk_live_…" }` whose value matches no value-pattern
    // must STILL be masked. Guards against regressing to globalRules-only.
    const defaultRedaction = {
      globalRules: DEFAULT_GLOBAL_RULES, // sensitiveKeys: []
      replacementFormat: "simple" as const,
    };
    const metadata: UploadMetadata = {
      ...baseMetadata(),
      contractsProjection: [
        {
          id: "POST /charge",
          cases: {
            ok: {
              schemas: {
                request: {
                  headers: { authorization: "sk_live_pattern_miss_0000" },
                  body: { password: "hunter2", apiKey: "AKIA_not_a_pattern" },
                },
              },
            },
          },
        },
      ] as unknown[],
    };

    const result = redactMetadataForUpload(metadata, defaultRedaction);
    const headers = (result.contractsProjection as any[])[0].cases.ok.schemas.request.headers;
    const body = (result.contractsProjection as any[])[0].cases.ok.schemas.request.body;
    expect(headers.authorization).toBe("[REDACTED]");
    expect(body.password).toBe("[REDACTED]");
    expect(body.apiKey).toBe("[REDACTED]");
  });

  test("redacts secrets inside the contract projection (sensitive keys + patterns)", () => {
    const metadata: UploadMetadata = {
      ...baseMetadata(),
      contractsProjection: [
        {
          id: "POST /login",
          cases: {
            success: {
              schemas: {
                request: { headers: { authorization: "Bearer super-secret-token" } },
                response: {
                  examples: [{ value: { contact: "alice@example.com" } }],
                },
              },
            },
          },
        },
      ] as unknown[],
    };

    const result = redactMetadataForUpload(metadata, REDACTION);
    const proj = (result.contractsProjection as any[])[0];

    // Sensitive-key match (authorization) is masked.
    expect(proj.cases.success.schemas.request.headers.authorization).toBe("[REDACTED]");
    // Pattern match (email) inside a nested example is masked.
    expect(proj.cases.success.schemas.response.examples[0].value.contact).not.toContain(
      "alice@example.com",
    );
    // Non-sensitive structural field survives.
    expect(proj.id).toBe("POST /login");
  });

  test("preserves JSON-Schema shape while masking scalar secrets (codex P2)", () => {
    // A login contract's request body schema declares `password`/`token`
    // properties — structural names, not secrets. The schema must survive
    // intact (canonical-hash/OpenAPI depend on it), while a real default
    // header secret is masked.
    const metadata: UploadMetadata = {
      ...baseMetadata(),
      contractsProjection: [
        {
          id: "POST /login",
          cases: {
            ok: {
              schemas: {
                request: {
                  body: {
                    type: "object",
                    properties: {
                      password: { type: "string", minLength: 8 },
                      token: { type: "string" },
                    },
                    required: ["password"],
                  },
                  headers: { authorization: "Bearer real-default" },
                },
              },
            },
          },
        },
      ] as unknown[],
    };

    const result = redactMetadataForUpload(metadata, REDACTION);
    const reqSchema = (result.contractsProjection as any[])[0].cases.ok.schemas.request;

    expect(reqSchema.body.properties.password).toEqual({ type: "string", minLength: 8 });
    expect(reqSchema.body.properties.token).toEqual({ type: "string" });
    expect(reqSchema.body.required).toEqual(["password"]);
    expect(reqSchema.headers.authorization).toBe("[REDACTED]");
  });

  test("nested secret under a non-sensitive inner key is caught via redaction config (by design)", () => {
    // `authorization: { value: "sk_live…" }` — the inner key `value` is not a
    // built-in sensitive key, and `sk_live…` matches no value pattern, so the
    // base config does NOT mask it (only scalars under SENSITIVE keys / pattern
    // hits are masked; containers are recursed to preserve schema shape). This
    // is the documented boundary: the project declares such shapes in its
    // redaction config — here, adding `value` to globalRules.sensitiveKeys.
    const metadata: UploadMetadata = {
      ...baseMetadata(),
      contractsProjection: [
        { id: "c", cases: { ok: { schemas: { request: { headers: { authorization: { value: "sk_live_SECRET" } } } } } } },
      ] as unknown[],
    };

    // Base config: NOT masked (recursed, inner key not sensitive).
    const baseResult = redactMetadataForUpload(metadata, {
      globalRules: DEFAULT_GLOBAL_RULES,
      replacementFormat: "simple",
    });
    expect(
      (baseResult.contractsProjection as any[])[0].cases.ok.schemas.request.headers.authorization.value,
    ).toBe("sk_live_SECRET");

    // Configured: add `value` to sensitiveKeys → now masked.
    const configured = redactMetadataForUpload(metadata, {
      globalRules: { ...DEFAULT_GLOBAL_RULES, sensitiveKeys: ["value"] },
      replacementFormat: "simple",
    });
    expect(
      (configured.contractsProjection as any[])[0].cases.ok.schemas.request.headers.authorization.value,
    ).toBe("[REDACTED]");
  });

  test("redacts literal values inside the workflow projection", () => {
    // A workflow's branch/switch projection carries literal compare values and
    // assertion messages (NormalizedPredicate.value, node.message). A secret
    // smuggled into one of those literals must be masked just like a contract
    // example. Here a branch case compares against a leaked bearer token.
    const metadata: UploadMetadata = {
      ...baseMetadata(),
      workflows: [
        {
          id: "signup",
          exportName: "signup",
          gradeSummary: { full: 1, partial: 0, opaque: 0 },
          nodes: [
            {
              kind: "branch",
              id: "b1",
              grade: "full",
              cases: [
                {
                  when: {
                    kind: "compare",
                    op: "eq",
                    path: ["headers", "authorization"],
                    value: "Bearer leaked-token",
                  },
                  nodes: [],
                },
              ],
            },
          ],
        },
      ] as unknown[],
    };

    const result = redactMetadataForUpload(metadata, REDACTION);
    const when = (result.workflows as any[])[0].nodes[0].cases[0].when;
    // "Bearer ..." matches the bearer pattern (enabled in DEFAULT_GLOBAL_RULES).
    expect(when.value).not.toContain("leaked-token");
    // Structural fields survive.
    expect(when.op).toBe("eq");
    expect(when.path).toEqual(["headers", "authorization"]);
  });

  test("NEVER touches files[].hash / rootHash (hexKeys must not mangle sha256)", () => {
    const metadata: UploadMetadata = {
      ...baseMetadata(),
      rootHash: "sha256-" + "f".repeat(64),
      // Presence of a projection bucket activates redaction.
      contractsProjection: [{ id: "noop", cases: {} }] as unknown[],
    } as UploadMetadata;

    const result = redactMetadataForUpload(metadata, REDACTION);

    expect(result.files["users.contract.ts"].hash).toBe("sha256-" + "a".repeat(64));
    expect((result as any).rootHash).toBe("sha256-" + "f".repeat(64));
  });

  test("returns the input unchanged when no projection buckets are present", () => {
    const metadata = baseMetadata();
    const result = redactMetadataForUpload(metadata, REDACTION);
    // Same reference — cheap no-op for the common (no-projection) upload.
    expect(result).toBe(metadata);
  });

  test("does not mutate the input projection", () => {
    const metadata: UploadMetadata = {
      ...baseMetadata(),
      contractsProjection: [
        { id: "c", cases: { s: { headers: { authorization: "secret" } } } },
      ] as unknown[],
    };
    const snapshot = JSON.parse(JSON.stringify(metadata.contractsProjection));

    redactMetadataForUpload(metadata, REDACTION);

    expect(metadata.contractsProjection).toEqual(snapshot);
  });
});
