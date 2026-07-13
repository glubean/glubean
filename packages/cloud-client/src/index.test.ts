import { afterEach, describe, expect, it, vi } from "vitest";

import { CloudApiError, GlubeanCloudClient, cloudFetchJson } from "./index.js";

afterEach(() => vi.restoreAllMocks());

describe("GlubeanCloudClient", () => {
  it("encodes resource ids and sends required idempotency identity", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ draftRevision: 2 }), { status: 200 }),
    );
    const client = new GlubeanCloudClient({
      apiUrl: "https://api.test/",
      projectId: "project one",
      token: "glb_secret",
    });

    await client.editApiDraft("api/one", {
      baseRevision: 1,
      idempotencyKey: "turn-1",
      edits: [{ op: "set", target: { kind: "info" }, field: ["description"], value: "Clear docs" }],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.test/v1/projects/project%20one/apis/api%2Fone/draft/edits",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer glb_secret" }),
        body: expect.stringContaining('"idempotencyKey":"turn-1"'),
      }),
    );
  });

  it("redacts bearer-shaped values from HTTP errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("proxy echoed Bearer glb_supersecret", { status: 500 }),
    );
    const error = await cloudFetchJson("https://api.test/v1", { token: "glb_supersecret" })
      .catch((value) => value as Error);
    expect(error.message).not.toContain("glb_supersecret");
    expect(error.message).toContain("[redacted]");
  });

  it("adds caller-specific recovery hints without weakening shared status handling", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("too large", { status: 413 }),
    );
    await expect(cloudFetchJson("https://api.test/v1", {
      token: "glb_secret",
      errorHints: { 413: "The run body exceeds the ingest cap." },
    })).rejects.toThrow(/Payload too large \(413\).*run body exceeds the ingest cap.*too large/s);
  });

  it("preserves the Platform API error code, issues, and recovery metadata", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        error: {
          code: "stale_draft_revision",
          message: "The API draft changed after it was read.",
          currentRevision: 12,
          issues: [{ code: "custom", path: ["draftRevision"], message: "Read the draft again." }],
        },
      }), { status: 409 }),
    );

    const error = await cloudFetchJson("https://api.test/v1", { token: "glb_secret" })
      .catch((value) => value as Error);
    expect(error).toBeInstanceOf(CloudApiError);
    expect(error).toMatchObject({
      status: 409,
      code: "stale_draft_revision",
      issues: [{ path: ["draftRevision"], message: "Read the draft again." }],
      meta: { currentRevision: 12 },
    });
  });

  it("accepts only explicitly typed error results and still throws other 409 responses", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({
        error: { code: "preview_required", message: "Preview this contract change." },
        previewUrl: "https://app.test/preview",
      }), { status: 409 }),
    );
    await expect(cloudFetchJson("https://api.test/v1", {
      token: "glb_secret",
      acceptedErrorCodes: ["preview_required"],
    })).resolves.toMatchObject({ previewUrl: "https://app.test/preview" });

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({
        error: {
          code: "hotfix_conflict",
          message: "The living draft conflicts with the active hotfix.",
          conflicts: [{ path: "$.paths" }],
        },
      }), { status: 409 }),
    );
    const error = await cloudFetchJson("https://api.test/v1", {
      token: "glb_secret",
      acceptedErrorCodes: ["preview_required"],
    }).catch((value) => value as CloudApiError);
    expect(error).toMatchObject({
      code: "hotfix_conflict",
      meta: { conflicts: [{ path: "$.paths" }] },
    });
  });

  it("normalizes preview-required envelopes into the release intent model", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        error: { code: "preview_required", message: "Preview first." },
        intentId: "ri_1",
        intentStatus: "awaiting_author_confirmation",
        candidateId: "cand_1",
        candidateRevision: 1,
        candidateStatus: "approved",
        previewRequired: true,
        previewUrl: "https://app.test/candidates/cand_1?revision=1",
        reviewUrl: null,
        classification: { docsOnly: false, reasons: ["Contract changed"] },
        capabilities: { canApprove: false, canRelease: false },
      }), { status: 409 }),
    );
    const client = new GlubeanCloudClient({
      apiUrl: "https://api.test",
      projectId: "project",
      token: "glb_secret",
    });

    const result = await client.submitApiRelease("api", {
      draftRevision: 2,
      releaseLabel: "2.0.0",
      previewMode: "preview",
      idempotencyKey: "release-1",
    });

    expect(result).toMatchObject({ previewRequired: true, candidateId: "cand_1" });
    expect(result).not.toHaveProperty("error");
  });

  it("pins a release edit session to the active revision the caller observed", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ session: { id: "ses_1" } }), { status: 201 }),
    );
    const client = new GlubeanCloudClient({
      apiUrl: "https://api.test",
      projectId: "project one",
      token: "glb_secret",
    });

    await client.createApiReleaseEditSession(
      "api/one",
      "rel/one",
      "rr_2",
      "Correct a typo",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.test/v1/projects/project%20one/apis/api%2Fone/releases/rel%2Fone/edit-sessions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          expectedActiveRevisionId: "rr_2",
          reason: "Correct a typo",
        }),
      }),
    );
  });

  it("can resume an existing release edit session by its stable ids", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ session: { id: "ses_1", editRevision: 2 } }), { status: 200 }),
    );
    const client = new GlubeanCloudClient({
      apiUrl: "https://api.test",
      projectId: "project one",
      token: "glb_secret",
    });

    await client.getApiReleaseEditSession("api/one", "rel/one", "ses/one");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.test/v1/projects/project%20one/apis/api%2Fone/releases/rel%2Fone/edit-sessions/ses%2Fone",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer glb_secret" }) }),
    );
  });
});
