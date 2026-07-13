/** Typed client for Glubean's project-scoped API authoring contract. */

export const API_DOCUMENT_SECTIONS = ["servers", "security", "tags", "externalDocs", "webhooks"] as const;
export const API_HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
export const API_COMPONENT_TYPES = ["schemas", "responses", "parameters", "requestBodies", "examples", "headers", "securitySchemes", "links", "callbacks", "pathItems"] as const;

export type ApiDocumentSection = (typeof API_DOCUMENT_SECTIONS)[number];
export type ApiHttpMethod = (typeof API_HTTP_METHODS)[number];
export type ApiComponentType = (typeof API_COMPONENT_TYPES)[number];

export type ApiDraftTarget =
  | { kind: "info" }
  | { kind: "document"; section: ApiDocumentSection }
  | { kind: "operation"; path: string; method: ApiHttpMethod }
  | { kind: "path"; path: string }
  | {
      kind: "component";
      componentType: ApiComponentType;
      name: string;
    };

export type ApiDraftEdit =
  | { op: "set"; target: ApiDraftTarget; field?: Array<string | number>; value: unknown }
  | { op: "remove"; target: ApiDraftTarget; field?: Array<string | number> };

export interface ApiDraftSummary {
  id: string;
  name: string;
  slug: string;
  baseSource: "manual" | "imported";
  draftRevision: number;
  editorPath: string;
  updatedAt: string;
}

export interface ApiDraft extends ApiDraftSummary {
  effectiveSpec: Record<string, unknown>;
}

export interface ApiDraftValidation {
  valid: boolean;
  issues: Array<Record<string, unknown>>;
  draftRevision: number;
  baseline: {
    releaseId: string;
    releaseLabel: string;
    releaseRevisionId: string;
    revision: number;
    compiledDigest: string;
    unsyncedHotfix: boolean;
  } | null;
  cumulativeDiff: {
    summary: {
      total: number;
      byCategory: Record<string, number>;
      endpoints: Record<string, number>;
      schemas: Record<string, number>;
    };
    changes: Array<Record<string, unknown>>;
  };
}

export interface ApiDraftEditResponse {
  apiId: string;
  draftRevision: number;
  changed: boolean;
  changes: Array<{ nodeId: string; editorPath: string }>;
  validation: ApiDraftValidation;
}

export interface ApiReleaseIntentResponse {
  intentId: string;
  intentStatus: "awaiting_author_confirmation" | "confirmed" | "completed" | "cancelled";
  candidateId: string;
  candidateRevision: number | null;
  candidateStatus: "pending_review" | "changes_requested" | "approved" | "released" | "superseded";
  previewRequired: boolean;
  previewUrl: string;
  reviewUrl: string | null;
  classification: { docsOnly: boolean; reasons: string[] };
  capabilities: { canApprove: boolean; canRelease: boolean };
}

export interface ApiCandidateStatus {
  candidate: {
    id: string;
    label: string;
    status: string;
    approvalPolicy: "none" | "all" | "any";
    activeRevisionId: string | null;
  };
  releaseIntent: {
    id: string;
    candidateRevisionId: string;
    previewMode: "preview" | "skip_if_safe";
    status: "awaiting_author_confirmation" | "confirmed" | "completed" | "cancelled";
    classification: { docsOnly: boolean; reasons: string[] };
    createdByUserId: string;
    confirmedByUserId: string | null;
    confirmedAt: string | null;
    createdAt: string;
  } | null;
  activeRevision: { id: string; revision: number; artifactId: string | null } | null;
  gate: { status: string; canRelease: boolean; pending: string[] };
}

export interface ApiReleaseEditSession {
  session: {
    id: string;
    releaseId: string;
    baseReleaseRevisionId: string;
    editRevision: number;
    reason: string;
    closedAt: string | null;
  };
  release: { id: string; label: string; activeRevisionId: string | null };
  live: boolean;
  warning: string;
  editorPath: string;
}

export interface ApiReleaseHistory {
  release: {
    id: string;
    label: string;
    activeRevisionId: string;
    releaseSequence: number;
  };
  activeRevision: {
    id: string;
    revision: number;
    kind: "initial" | "emergency_fix";
    reason: string | null;
  };
  live: boolean;
}

export interface ApiReleaseFixApplied {
  releaseId: string;
  releaseRevisionId: string;
  draftRevision: number;
  changes: Array<{ nodeId: string; editorPath: string }>;
}

export interface CloudClientOptions {
  apiUrl: string;
  projectId: string;
  token: string;
  timeoutMs?: number;
}

export interface CloudFetchOptions extends RequestInit {
  token: string;
  timeoutMs?: number;
  /** Optional product-specific recovery guidance. The shared transport owns
   * the status wording; callers add only the scope/resource hints they know. */
  errorHints?: CloudHttpErrorHints;
  /** Error codes that are part of a method's typed result (for example the
   *  preview_required 409). Every other non-2xx response still throws. */
  acceptedErrorCodes?: string[];
}

export type CloudHttpErrorStatus = 401 | 403 | 404 | 413 | 429;
export type CloudHttpErrorHints = Partial<Record<CloudHttpErrorStatus, string>>;

export interface CloudApiErrorIssue {
  code?: string;
  path?: Array<string | number>;
  message: string;
}

/** Structured Platform API failure retained for agent recovery. The message is
 *  safe for humans; code/issues/meta preserve the machine-readable envelope. */
export class CloudApiError extends Error {
  readonly name = "CloudApiError";

  constructor(
    readonly status: number,
    message: string,
    readonly code: string | null,
    readonly issues: CloudApiErrorIssue[] | null,
    readonly meta: Record<string, unknown> | null,
  ) {
    super(message);
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;

function scrubTokens(text: string): string {
  return text
    .replace(/glb_[A-Za-z0-9_-]{6,}/g, "glb_[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, "Bearer [redacted]");
}

function friendlyHttpError(status: number, body: string, hints: CloudHttpErrorHints = {}): string {
  const detail = scrubTokens(body.slice(0, 2000));
  const hint = hints[status as CloudHttpErrorStatus];
  const suffix = [hint, detail].filter(Boolean).join(" ");
  switch (status) {
    case 401:
      return `Unauthorized (401): the Cloud rejected the token. Check GLUBEAN_TOKEN or run \`glubean login\`. ${suffix}`;
    case 403:
      return `Forbidden (403): the token lacks the required scope or project membership. ${suffix}`;
    case 404:
      return `Not found (404): check the project and resource ids, and verify the Platform API URL. ${suffix}`;
    case 413:
      return `Payload too large (413). ${suffix}`;
    case 429:
      return `Cloud quota exceeded (429). ${suffix}`;
    default:
      return `HTTP ${status}: ${detail}`;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function structuredHttpError(
  status: number,
  body: string,
  hints: CloudHttpErrorHints = {},
): CloudApiError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = null;
  }
  const raw = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : null;
  const code = typeof raw?.code === "string" ? raw.code : null;
  const issues = Array.isArray(raw?.issues)
    ? raw.issues.flatMap((issue): CloudApiErrorIssue[] => {
        if (!isRecord(issue) || typeof issue.message !== "string") return [];
        return [{
          ...(typeof issue.code === "string" ? { code: issue.code } : {}),
          ...(Array.isArray(issue.path)
            ? { path: issue.path.filter((part): part is string | number =>
                typeof part === "string" || typeof part === "number") }
            : {}),
          message: issue.message,
        }];
      })
    : null;
  const inlineMeta = raw
    ? Object.fromEntries(
        Object.entries(raw).filter(([key]) => !["code", "message", "issues", "meta"].includes(key)),
      )
    : {};
  const nestedMeta = raw && isRecord(raw.meta) ? raw.meta : {};
  const meta = { ...nestedMeta, ...inlineMeta };
  const detail = typeof raw?.message === "string" ? raw.message : body;
  return new CloudApiError(
    status,
    friendlyHttpError(status, detail, hints),
    code,
    issues?.length ? issues : null,
    Object.keys(meta).length ? meta : null,
  );
}

export async function cloudFetchJson(url: string, init: CloudFetchOptions): Promise<unknown> {
  const { token, timeoutMs, acceptedErrorCodes = [], errorHints, ...fetchInit } = init;
  const budget = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budget);
  let response: Response;
  try {
    response = await fetch(url, {
      ...fetchInit,
      signal: controller.signal,
      headers: { ...(fetchInit.headers ?? {}), Authorization: `Bearer ${token}` },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`Request to Glubean Cloud timed out after ${budget}ms — check the API URL and network.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  if (!response.ok) {
    const error = structuredHttpError(response.status, text, errorHints);
    if (!error.code || !acceptedErrorCodes.includes(error.code)) throw error;
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function baseUrl(apiUrl: string, projectId: string): string {
  return `${apiUrl.replace(/\/+$/, "")}/v1/projects/${encodeURIComponent(projectId)}/apis`;
}

function apiUrl(options: CloudClientOptions, apiId: string): string {
  return `${baseUrl(options.apiUrl, options.projectId)}/${encodeURIComponent(apiId)}`;
}

function request(options: CloudClientOptions, path: string, init: Omit<CloudFetchOptions, "token"> = {}) {
  return cloudFetchJson(path, { ...init, token: options.token, timeoutMs: options.timeoutMs });
}

function releaseIntentResult(value: unknown): ApiReleaseIntentResponse {
  if (!isRecord(value) || typeof value.previewUrl !== "string") {
    throw new Error(`Release intent rejected: ${scrubTokens(JSON.stringify(value))}`);
  }
  const { error: _acceptedPreviewError, ...result } = value;
  return result as unknown as ApiReleaseIntentResponse;
}

export class GlubeanCloudClient {
  constructor(private readonly options: CloudClientOptions) {}

  listApiDrafts(): Promise<ApiDraftSummary[]> {
    return request(this.options, baseUrl(this.options.apiUrl, this.options.projectId)) as Promise<ApiDraftSummary[]>;
  }

  readApiDraft(apiId: string): Promise<ApiDraft> {
    return request(this.options, `${apiUrl(this.options, apiId)}/draft`) as Promise<ApiDraft>;
  }

  editApiDraft(
    apiId: string,
    input: {
      baseRevision: number;
      idempotencyKey: string;
      source?: { kind: "ide-agent"; workspace?: string; references?: string[] };
      edits: ApiDraftEdit[];
    },
  ): Promise<ApiDraftEditResponse> {
    return request(this.options, `${apiUrl(this.options, apiId)}/draft/edits`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }) as Promise<ApiDraftEditResponse>;
  }

  validateApiDraft(apiId: string): Promise<ApiDraftValidation> {
    return request(this.options, `${apiUrl(this.options, apiId)}/draft/validate`, { method: "POST" }) as Promise<ApiDraftValidation>;
  }

  async submitApiRelease(
    apiId: string,
    input: {
      draftRevision: number;
      releaseLabel: string;
      title?: string;
      summary?: string;
      previewMode: "preview" | "skip_if_safe";
      reviewers?: string[];
      idempotencyKey: string;
      acknowledgeHotfixRevertReason?: string;
    },
  ): Promise<ApiReleaseIntentResponse> {
    const result = await request(this.options, `${apiUrl(this.options, apiId)}/release-intents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      acceptedErrorCodes: ["preview_required"],
    });
    return releaseIntentResult(result);
  }

  getApiReleaseStatus(apiId: string, candidateId: string): Promise<ApiCandidateStatus> {
    return request(
      this.options,
      `${apiUrl(this.options, apiId)}/candidates/${encodeURIComponent(candidateId)}`,
    ) as Promise<ApiCandidateStatus>;
  }

  listApiReleases(apiId: string): Promise<ApiReleaseHistory[]> {
    return request(this.options, `${apiUrl(this.options, apiId)}/releases`) as Promise<ApiReleaseHistory[]>;
  }

  createApiReleaseEditSession(
    apiId: string,
    releaseId: string,
    expectedActiveRevisionId: string,
    reason: string,
  ): Promise<ApiReleaseEditSession> {
    return request(
      this.options,
      `${apiUrl(this.options, apiId)}/releases/${encodeURIComponent(releaseId)}/edit-sessions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedActiveRevisionId, reason }),
      },
    ) as Promise<ApiReleaseEditSession>;
  }

  getApiReleaseEditSession(
    apiId: string,
    releaseId: string,
    sessionId: string,
  ): Promise<ApiReleaseEditSession> {
    return request(
      this.options,
      `${apiUrl(this.options, apiId)}/releases/${encodeURIComponent(releaseId)}/edit-sessions/${encodeURIComponent(sessionId)}`,
    ) as Promise<ApiReleaseEditSession>;
  }

  editApiReleaseSession(
    apiId: string,
    releaseId: string,
    sessionId: string,
    input: { baseRevision: number; edits: ApiDraftEdit[] },
  ): Promise<ApiReleaseEditSession> {
    return request(
      this.options,
      `${apiUrl(this.options, apiId)}/releases/${encodeURIComponent(releaseId)}/edit-sessions/${encodeURIComponent(sessionId)}/edits`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) },
    ) as Promise<ApiReleaseEditSession>;
  }

  async submitApiReleaseEditSession(
    apiId: string,
    releaseId: string,
    sessionId: string,
    input: {
      expectedEditRevision: number;
      title?: string;
      summary?: string;
      previewMode: "preview" | "skip_if_safe";
      reviewers?: string[];
      idempotencyKey: string;
    },
  ): Promise<ApiReleaseIntentResponse> {
    const result = await request(
      this.options,
      `${apiUrl(this.options, apiId)}/releases/${encodeURIComponent(releaseId)}/edit-sessions/${encodeURIComponent(sessionId)}/submit`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        acceptedErrorCodes: ["preview_required"],
      },
    );
    return releaseIntentResult(result);
  }

  applyApiReleaseFixToDraft(
    apiId: string,
    releaseId: string,
    releaseRevisionId: string,
    expectedDraftRevision: number,
    idempotencyKey: string,
  ): Promise<ApiReleaseFixApplied> {
    return request(
      this.options,
      `${apiUrl(this.options, apiId)}/releases/${encodeURIComponent(releaseId)}/revisions/${encodeURIComponent(releaseRevisionId)}/apply-to-draft`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ expectedDraftRevision }),
      },
    ) as Promise<ApiReleaseFixApplied>;
  }

  publishApiReleaseRevision(
    apiId: string,
    releaseId: string,
    releaseRevisionId: string,
    input: { reason: string; visibility?: "public" | "private" },
    idempotencyKey: string,
  ): Promise<Record<string, unknown>> {
    return request(
      this.options,
      `${apiUrl(this.options, apiId)}/releases/${encodeURIComponent(releaseId)}/revisions/${encodeURIComponent(releaseRevisionId)}/publish`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify(input),
      },
    ) as Promise<Record<string, unknown>>;
  }
}

function client(apiUrlValue: string, projectId: string, token: string): GlubeanCloudClient {
  return new GlubeanCloudClient({ apiUrl: apiUrlValue, projectId, token });
}

export const listApiDrafts = (apiUrlValue: string, projectId: string, token: string) =>
  client(apiUrlValue, projectId, token).listApiDrafts();
export const readApiDraft = (apiUrlValue: string, projectId: string, apiId: string, token: string) =>
  client(apiUrlValue, projectId, token).readApiDraft(apiId);
export const editApiDraft = (
  apiUrlValue: string,
  projectId: string,
  apiId: string,
  token: string,
  input: Parameters<GlubeanCloudClient["editApiDraft"]>[1],
) => client(apiUrlValue, projectId, token).editApiDraft(apiId, input);
export const validateApiDraft = (apiUrlValue: string, projectId: string, apiId: string, token: string) =>
  client(apiUrlValue, projectId, token).validateApiDraft(apiId);
export const submitApiRelease = (
  apiUrlValue: string,
  projectId: string,
  apiId: string,
  token: string,
  input: Parameters<GlubeanCloudClient["submitApiRelease"]>[1],
) => client(apiUrlValue, projectId, token).submitApiRelease(apiId, input);
export const getApiReleaseStatus = (
  apiUrlValue: string,
  projectId: string,
  apiId: string,
  candidateId: string,
  token: string,
) => client(apiUrlValue, projectId, token).getApiReleaseStatus(apiId, candidateId);
export const listApiReleases = (
  apiUrlValue: string,
  projectId: string,
  apiId: string,
  token: string,
) => client(apiUrlValue, projectId, token).listApiReleases(apiId);
export const createApiReleaseEditSession = (
  apiUrlValue: string,
  projectId: string,
  apiId: string,
  releaseId: string,
  token: string,
  expectedActiveRevisionId: string,
  reason: string,
) => client(apiUrlValue, projectId, token).createApiReleaseEditSession(
  apiId,
  releaseId,
  expectedActiveRevisionId,
  reason,
);
export const editApiReleaseSession = (
  apiUrlValue: string,
  projectId: string,
  apiId: string,
  releaseId: string,
  sessionId: string,
  token: string,
  input: Parameters<GlubeanCloudClient["editApiReleaseSession"]>[3],
) => client(apiUrlValue, projectId, token).editApiReleaseSession(apiId, releaseId, sessionId, input);
export const getApiReleaseEditSession = (
  apiUrlValue: string,
  projectId: string,
  apiId: string,
  releaseId: string,
  sessionId: string,
  token: string,
) => client(apiUrlValue, projectId, token).getApiReleaseEditSession(apiId, releaseId, sessionId);
export const submitApiReleaseEditSession = (
  apiUrlValue: string,
  projectId: string,
  apiId: string,
  releaseId: string,
  sessionId: string,
  token: string,
  input: Parameters<GlubeanCloudClient["submitApiReleaseEditSession"]>[3],
) => client(apiUrlValue, projectId, token).submitApiReleaseEditSession(apiId, releaseId, sessionId, input);
export const applyApiReleaseFixToDraft = (
  apiUrlValue: string,
  projectId: string,
  apiId: string,
  releaseId: string,
  releaseRevisionId: string,
  token: string,
  expectedDraftRevision: number,
  idempotencyKey: string,
) => client(apiUrlValue, projectId, token).applyApiReleaseFixToDraft(
  apiId,
  releaseId,
  releaseRevisionId,
  expectedDraftRevision,
  idempotencyKey,
);
