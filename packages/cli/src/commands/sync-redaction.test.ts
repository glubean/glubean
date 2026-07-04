/**
 * GLU-123 (Urgent, fixed) / GLU-107 (orphan cleanup) regression.
 *
 * `sync.ts`'s `redactStructure` — the redactor applied to contract/workflow
 * `projection` bodies and the OpenAPI doc before upload — used to hardcode
 * `sensitiveKeys: []`, on the theory that key-based redaction would mask
 * JSON-Schema field names (`properties.password`) and corrupt the
 * projection. That theory didn't hold (the engine's `sensitiveKeyRecurse:
 * true` default recurses INTO an object/array under a sensitive key instead
 * of replacing it wholesale — only scalar leaves get masked), and the actual
 * cost was real: `cookie` / `set-cookie` / `sessionid` / `session_id` (not
 * covered by the built-in VALUE patterns) uploaded to Cloud in cleartext
 * whenever a contract's `extensions`/case `extensions` carried them (common
 * on a cookie-auth API contract's example/default header).
 *
 * This pins the fix end-to-end through the REAL redaction engine
 * (`@glubean/redaction`'s `redactValue`), the REAL SDK contract projection
 * (`@glubean/scanner`'s dry-run path via `buildProjections`), and the actual
 * `syncCommand` upload wiring — not a reimplementation of the redaction
 * logic in the test.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { syncCommand } from "./sync.js";

// Fixture root lives INSIDE the CLI package tree so the fixture project's
// `import { contract } from "@glubean/sdk"` resolves via the workspace's
// hoisted node_modules (see bootstrap-integration.test.ts /
// workflow-metadata-integration.test.ts for the same pattern). Matches the
// `.tmp-test*/` .gitignore pattern.
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(HERE, "..", "..", ".tmp-test-sync-redaction");

const REAL_COOKIE = "sessid=REALCOOKIEVALUE_do_not_upload_9f8e7d6c";
const REAL_SET_COOKIE = "sessid=REALCOOKIEVALUE_do_not_upload_9f8e7d6c; HttpOnly; Path=/";
const REAL_SESSIONID = "REALSESSIONID_do_not_upload_1a2b3c4d";
const REAL_SESSION_ID_ALT = "REALSESSIONID_do_not_upload_alt_5e6f7a8b";

let fixtureSeq = 0;
let fixtureDir: string;
let fetchMock: ReturnType<typeof vi.fn>;

function minimalPackageJson(name: string): string {
  return JSON.stringify(
    { name, type: "module", version: "0.0.0", dependencies: { "@glubean/sdk": "workspace:*" } },
    null,
    2,
  );
}

/** The fixture contract: cookie/session secrets in extensions (contract-level
 * AND case-level), plus a JSON-Schema response body whose PROPERTY NAMES are
 * literally `password`/`cookie` (structural field names, never secrets) —
 * pinning that key-based redaction recurses into (not replaces) the schema. */
function contractFixtureSource(): string {
  return `
import { contract } from "@glubean/sdk";

const api = contract.http.with("secrets-api", {
  client: { request: async () => ({ status: 200, body: {} }) },
  security: null,
  extensions: {
    cookie: ${JSON.stringify(REAL_COOKIE)},
    "set-cookie": ${JSON.stringify(REAL_SET_COOKIE)},
  },
});

const responseSchema = {
  safeParse: (data) => ({ success: true, data }),
  jsonSchema: {
    type: "object",
    properties: {
      password: { type: "string", description: "user password field (schema NAME, not a secret)" },
      cookie: { type: "string", description: "cookie field NAME on the schema, not a value" },
    },
  },
};

// @contract
export const secretsContract = api("secrets-contract", {
  endpoint: "GET /api/secure",
  feature: "GLU-123 regression",
  description: "carries real cookie/session secrets in extensions",
  extensions: {
    sessionid: ${JSON.stringify(REAL_SESSIONID)},
  },
  cases: {
    ok: {
      description: "ok",
      extensions: {
        session_id: ${JSON.stringify(REAL_SESSION_ID_ALT)},
      },
      expect: { status: 200, schema: responseSchema },
    },
  },
});
`;
}

/** GLU-195 fixture: a workflow whose action declares structured session
 * behavior. Cookie NAMES (`better-auth.session_token`) are identifiers that MUST
 * survive redaction so the Specs inspector can render them; a real cookie VALUE
 * placed in the workflow's `extensions.cookie` (a direct scalar under a
 * sensitive key) MUST still be masked. Pins that the nested `cookies.read/set`
 * shape (not a flat `cookiesRead` key) keeps the names upload-safe. */
function workflowFixtureSource(): string {
  return `
import { workflow } from "@glubean/sdk";

// @workflow
export const authJourney = workflow({
  id: "auth-journey",
  name: "Auth journey",
  extensions: { cookie: ${JSON.stringify(REAL_COOKIE)} },
})
  .setup(async () => ({}))
  .action("get-session-with-cookie", async (_c, s) => s, {
    project: {
      session: {
        cookies: {
          read: ["better-auth.session_token"],
          set: ["better-auth.session_data"],
        },
        headers: ["Authorization"],
        lifecycle: "read",
      },
      verify: [{ message: "session endpoint returns 200", target: "res.status" }],
    },
  })
  .build();
`;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(async () => {
  fixtureSeq += 1;
  fixtureDir = join(FIXTURE_ROOT, String(fixtureSeq));
  await mkdir(join(fixtureDir, "contracts"), { recursive: true });
  await writeFile(join(fixtureDir, "package.json"), minimalPackageJson("sync-redaction-fixture"));
  await writeFile(join(fixtureDir, "contracts", "secrets.contract.ts"), contractFixtureSource());
  await writeFile(join(fixtureDir, "auth.flow.ts"), workflowFixtureSource());

  fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ upserted: 1 })));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(fixtureDir, { recursive: true, force: true });
});

afterAll(async () => {
  await rm(FIXTURE_ROOT, { recursive: true, force: true });
});

/** Find the POST body sent to `${base}/${kind}` — sync.ts posts test/contract/
 * workflow/openapi separately; locate by URL suffix rather than call order. */
function bodyForKind(kind: string): unknown {
  const call = fetchMock.mock.calls.find(([url]: [string]) => (url as string).endsWith(`/${kind}`));
  expect(call, `no fetch call for kind "${kind}"`).toBeDefined();
  return JSON.parse(call![1].body as string);
}

describe("GLU-123 — glubean sync redacts contract projection extensions before upload", () => {
  test("cookie/set-cookie/sessionid/session_id are masked, never uploaded in cleartext", async () => {
    await syncCommand({
      dir: fixtureDir,
      token: "gb_test_token",
      project: "proj_test",
      apiUrl: "https://api.glubean.test",
      allowEmpty: true,
    });

    const contractBody = bodyForKind("contract") as { contracts: Array<{ projection: any }> };
    expect(contractBody.contracts).toHaveLength(1);
    const projection = contractBody.contracts[0].projection;

    const serialized = JSON.stringify(projection);
    // The actual secret VALUES must never appear in the uploaded payload.
    expect(serialized).not.toContain(REAL_COOKIE);
    expect(serialized).not.toContain(REAL_SET_COOKIE);
    expect(serialized).not.toContain(REAL_SESSIONID);
    expect(serialized).not.toContain(REAL_SESSION_ID_ALT);

    // The values were actually masked, not silently dropped (a masked
    // sentinel is present at each sensitive-keyed path) — proves this is
    // redaction, not e.g. a field being stripped for an unrelated reason.
    expect(typeof projection.extensions.cookie).toBe("string");
    expect(projection.extensions.cookie).not.toBe(REAL_COOKIE);
    expect(typeof projection.extensions["set-cookie"]).toBe("string");
    expect(projection.extensions["set-cookie"]).not.toBe(REAL_SET_COOKIE);
    expect(typeof projection.extensions.sessionid).toBe("string");
    expect(projection.extensions.sessionid).not.toBe(REAL_SESSIONID);

    const caseExt = projection.cases[0].extensions;
    expect(typeof caseExt.session_id).toBe("string");
    expect(caseExt.session_id).not.toBe(REAL_SESSION_ID_ALT);
  });

  test("JSON-Schema property names literally called `password`/`cookie` keep their shape (key-based redaction recurses, never replaces the node wholesale)", async () => {
    await syncCommand({
      dir: fixtureDir,
      token: "gb_test_token",
      project: "proj_test",
      apiUrl: "https://api.glubean.test",
      allowEmpty: true,
    });

    const contractBody = bodyForKind("contract") as { contracts: Array<{ projection: any }> };
    const projection = contractBody.contracts[0].projection;
    const bodySchema = projection.cases[0].schemas?.response?.body;

    expect(bodySchema).toBeDefined();
    expect(bodySchema.type).toBe("object");
    // The property NAMES survive verbatim — redacting a sensitive KEY must
    // never delete/rename the schema field itself.
    expect(Object.keys(bodySchema.properties)).toEqual(
      expect.arrayContaining(["password", "cookie"]),
    );
    // Their inner `type`/`description` structure (non-secret schema
    // metadata) is untouched — proves recursion, not wholesale replacement.
    expect(bodySchema.properties.password.type).toBe("string");
    expect(bodySchema.properties.password.description).toBe(
      "user password field (schema NAME, not a secret)",
    );
    expect(bodySchema.properties.cookie.type).toBe("string");
    expect(bodySchema.properties.cookie.description).toBe(
      "cookie field NAME on the schema, not a value",
    );
  });
});

describe("GLU-195 — workflow node session.cookies NAMES survive upload; a real cookie VALUE still redacts", () => {
  test("cookie/header identifiers in a node's `session` hint upload verbatim, but extensions.cookie is masked", async () => {
    await syncCommand({
      dir: fixtureDir,
      token: "gb_test_token",
      project: "proj_test",
      apiUrl: "https://api.glubean.test",
      allowEmpty: true,
    });

    const workflowBody = bodyForKind("workflow") as {
      workflows: Array<{ workflowId: string; projection: any }>;
    };
    const wf = workflowBody.workflows.find((w) => w.workflowId === "auth-journey");
    expect(wf, "auth-journey workflow uploaded").toBeDefined();
    const projection = wf!.projection;
    const serialized = JSON.stringify(projection);

    // The cookie/header NAMES are structural identifiers — they MUST survive so
    // the Specs inspector can render them first-class (the whole point of GLU-195).
    expect(serialized).toContain("better-auth.session_token");
    expect(serialized).toContain("better-auth.session_data");
    const actionNode = projection.nodes.find((n: any) => n.id === "get-session-with-cookie");
    expect(actionNode).toBeDefined();
    expect(actionNode.session).toEqual({
      cookies: {
        read: ["better-auth.session_token"],
        set: ["better-auth.session_data"],
      },
      headers: ["Authorization"],
      lifecycle: "read",
    });
    expect(actionNode.verify).toEqual([
      { message: "session endpoint returns 200", target: "res.status" },
    ]);

    // …while a REAL cookie VALUE sitting under a sensitive key (the workflow's
    // `extensions.cookie`) is still masked — GLU-123's protection is intact.
    expect(serialized).not.toContain(REAL_COOKIE);
    expect(typeof projection.extensions.cookie).toBe("string");
    expect(projection.extensions.cookie).not.toBe(REAL_COOKIE);
  });
});
