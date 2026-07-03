/**
 * GLU-127 — OpenAPI component schema hoisting.
 *
 * `buildOpenApiPartForHttp` intentionally still writes body schemas INLINE
 * (per-contract, it has no cross-operation view). `mergeOpenApiParts` is
 * where hoisting happens — these tests exercise it directly with hand-built
 * partials, mirroring the `OpenApiSourceContract` nested-schema shape
 * (`schemas.request.body`, `cases[].schemas.response.body`) that
 * `readContractFields`/`readCaseFields` read.
 */

import { describe, expect, test } from "vitest";
import { buildOpenApiPartForHttp, mergeOpenApiParts } from "./openapi.js";

function contract(opts: {
  id: string;
  method?: string;
  path: string;
  requestBody?: unknown;
  cases: Array<{
    key: string;
    status: number;
    responseBody?: unknown;
  }>;
}) {
  return {
    id: opts.id,
    protocol: "http",
    target: `${opts.method ?? "POST"} ${opts.path}`,
    description: opts.id,
    schemas: {
      request: opts.requestBody ? { body: opts.requestBody } : {},
    },
    cases: opts.cases.map((c) => ({
      key: c.key,
      description: c.key,
      schemas: {
        response: { status: c.status, body: c.responseBody },
      },
    })),
  };
}

describe("mergeOpenApiParts — component schema hoisting (GLU-127)", () => {
  test("object body schema with properties is hoisted into components.schemas with a $ref in place", () => {
    const part = buildOpenApiPartForHttp(
      contract({
        id: "auth.sign-in.email",
        path: "/api/auth/sign-in/email",
        requestBody: {
          type: "object",
          properties: { email: { type: "string" }, password: { type: "string" } },
          required: ["email", "password"],
        },
        cases: [
          {
            key: "ok",
            status: 200,
            responseBody: {
              type: "object",
              properties: { user: { type: "object", properties: { id: { type: "string" } } } },
            },
          },
        ],
      }) as any,
    );
    const doc = mergeOpenApiParts([part!]);
    const components = doc.components as { schemas?: Record<string, unknown> };

    expect(components.schemas).toHaveProperty("AuthSignInEmailRequest");
    expect(components.schemas).toHaveProperty("AuthSignInEmailResponse");

    const op = (doc.paths as any)["/api/auth/sign-in/email"].post;
    expect(op.requestBody.content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/AuthSignInEmailRequest",
    });
    expect(op.responses["200"].content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/AuthSignInEmailResponse",
    });
  });

  test("structurally identical schemas across different contracts dedupe to one component", () => {
    const errorEnvelope = {
      type: "object",
      properties: { message: { type: "string" }, code: { type: "string" } },
    };
    const partA = buildOpenApiPartForHttp(
      contract({
        id: "auth.sign-in.email",
        path: "/api/auth/sign-in/email",
        cases: [{ key: "badCreds", status: 401, responseBody: errorEnvelope }],
      }) as any,
    );
    const partB = buildOpenApiPartForHttp(
      contract({
        id: "auth.sign-up.email",
        path: "/api/auth/sign-up/email",
        cases: [{ key: "badInput", status: 400, responseBody: errorEnvelope }],
      }) as any,
    );
    const doc = mergeOpenApiParts([partA!, partB!]);
    const components = doc.components as { schemas: Record<string, unknown> };

    // Only ONE component was minted for the shared shape — not one per contract.
    const schemaNames = Object.keys(components.schemas);
    expect(schemaNames.length).toBe(1);

    const refA = ((doc.paths as any)["/api/auth/sign-in/email"].post.responses["401"]
      .content["application/json"].schema) as { $ref: string };
    const refB = ((doc.paths as any)["/api/auth/sign-up/email"].post.responses["400"]
      .content["application/json"].schema) as { $ref: string };
    expect(refA.$ref).toBe(refB.$ref);
  });

  test("an explicit JSON Schema `title` is preferred over the derived contract-id name", () => {
    const part = buildOpenApiPartForHttp(
      contract({
        id: "auth.sign-in.email",
        path: "/api/auth/sign-in/email",
        cases: [
          {
            key: "badCreds",
            status: 401,
            responseBody: {
              type: "object",
              title: "ErrorResponse",
              properties: { message: { type: "string" } },
            },
          },
        ],
      }) as any,
    );
    const doc = mergeOpenApiParts([part!]);
    const components = doc.components as { schemas: Record<string, unknown> };

    expect(components.schemas).toHaveProperty("ErrorResponse");
    expect(components.schemas).not.toHaveProperty("AuthSignInEmailResponse401");
  });

  test("trivial primitive/property-less schemas stay inline (not hoisted)", () => {
    const part = buildOpenApiPartForHttp(
      contract({
        id: "health.check",
        path: "/health",
        method: "GET",
        cases: [
          { key: "csv", status: 200, responseBody: { type: "string" } },
        ],
      }) as any,
    );
    const doc = mergeOpenApiParts([part!]);
    expect(doc.components).toBeUndefined();

    const op = (doc.paths as any)["/health"].get;
    expect(op.responses["200"].content["application/json"].schema).toEqual({ type: "string" });
  });

  test("a contract with two distinct response body shapes gets a status-suffixed second name", () => {
    const part = buildOpenApiPartForHttp(
      contract({
        id: "auth.sign-in.email",
        path: "/api/auth/sign-in/email",
        cases: [
          {
            key: "ok",
            status: 200,
            responseBody: { type: "object", properties: { user: { type: "string" } } },
          },
          {
            key: "badCreds",
            status: 401,
            responseBody: { type: "object", properties: { message: { type: "string" } } },
          },
        ],
      }) as any,
    );
    const doc = mergeOpenApiParts([part!]);
    const components = doc.components as { schemas: Record<string, unknown> };

    expect(components.schemas).toHaveProperty("AuthSignInEmailResponse");
    expect(components.schemas).toHaveProperty("AuthSignInEmailResponse401");
  });

  test("array-typed body schemas are hoisted too", () => {
    const part = buildOpenApiPartForHttp(
      contract({
        id: "platform.projects.list",
        path: "/v1/projects",
        method: "GET",
        cases: [
          {
            key: "list",
            status: 200,
            responseBody: {
              type: "array",
              items: { type: "object", properties: { id: { type: "string" } } },
            },
          },
        ],
      }) as any,
    );
    const doc = mergeOpenApiParts([part!]);
    const components = doc.components as { schemas: Record<string, unknown> };
    expect(components.schemas).toHaveProperty("PlatformProjectsListResponse");
  });

  test("collision-list operations (GLU-116 x-glubean-surface-collisions) are hoisted and dedupe against the canonical operation", () => {
    const healthBody = {
      type: "object",
      properties: { status: { type: "string" } },
    };
    const canonical = buildOpenApiPartForHttp(
      contract({
        id: "dashboard.health",
        path: "/health",
        method: "GET",
        cases: [{ key: "healthy", status: 200, responseBody: healthBody }],
      }) as any,
    );
    const surface = buildOpenApiPartForHttp(
      contract({
        id: "platform.health",
        path: "/health",
        method: "GET",
        cases: [{ key: "healthy", status: 200, responseBody: healthBody }],
      }) as any,
    );
    const doc = mergeOpenApiParts([canonical!, surface!]);
    const components = doc.components as { schemas: Record<string, unknown> };
    const collisions = doc["x-glubean-surface-collisions"] as Array<{
      operation: Record<string, any>;
    }>;

    expect(collisions.length).toBe(1);
    const canonicalRef = (doc.paths as any)["/health"].get.responses["200"].content[
      "application/json"
    ].schema as { $ref: string };
    const collisionRef = collisions[0].operation.responses["200"].content[
      "application/json"
    ].schema as { $ref: string };

    // Same component reused — not duplicated once for the canonical slot and
    // once for the collision entry.
    expect(collisionRef.$ref).toBe(canonicalRef.$ref);
    expect(Object.keys(components.schemas).length).toBe(1);
  });

  test("naming is deterministic — the same contracts merged independently twice produce byte-identical output", () => {
    const build = () => {
      const part = buildOpenApiPartForHttp(
        contract({
          id: "auth.sign-in.email",
          path: "/api/auth/sign-in/email",
          requestBody: {
            type: "object",
            properties: { email: { type: "string" } },
          },
          cases: [
            {
              key: "ok",
              status: 200,
              responseBody: { type: "object", properties: { user: { type: "string" } } },
            },
            {
              key: "badCreds",
              status: 401,
              responseBody: { type: "object", properties: { message: { type: "string" } } },
            },
          ],
        }) as any,
      );
      return mergeOpenApiParts([part!]);
    };

    const once = build();
    const twice = build();
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  test("a schema already expressed as a $ref is left untouched (idempotent re-merge)", () => {
    const alreadyRef = {
      paths: {
        "/x": {
          get: {
            operationId: "x",
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/Foo" },
                  },
                },
              },
            },
          },
        },
      },
      components: { schemas: { Foo: { type: "object", properties: { a: { type: "string" } } } } },
    };
    const doc = mergeOpenApiParts([alreadyRef as any]);

    // The pass doesn't merge inbound `components.schemas` (no producer ever
    // emits one — `buildOpenApiPartForHttp` never does), so `Foo` itself
    // isn't carried through; what matters is the pass doesn't choke on or
    // rewrite an existing $ref it finds inline.
    expect((doc.paths as any)["/x"].get.responses["200"].content["application/json"].schema).toEqual(
      { $ref: "#/components/schemas/Foo" },
    );
  });

  // codex R1 P2 — regression coverage for both findings.

  test("a genuine `title` schema PROPERTY doesn't collide with a schema lacking it (dedup must not strip nested `title` fields)", () => {
    const withTitleProperty = {
      type: "object",
      properties: { name: { type: "string" }, title: { type: "string" } },
    };
    const withoutTitleProperty = {
      type: "object",
      properties: { name: { type: "string" } },
    };
    const partA = buildOpenApiPartForHttp(
      contract({ id: "posts.create", path: "/posts", cases: [{ key: "ok", status: 201, responseBody: withTitleProperty }] }) as any,
    );
    const partB = buildOpenApiPartForHttp(
      contract({ id: "authors.create", path: "/authors", cases: [{ key: "ok", status: 201, responseBody: withoutTitleProperty }] }) as any,
    );
    const doc = mergeOpenApiParts([partA!, partB!]);
    const components = doc.components as { schemas: Record<string, unknown> };

    // Two DIFFERENT shapes (one has a `title` property, one doesn't) must
    // mint two DIFFERENT components — not dedupe into one.
    expect(Object.keys(components.schemas).length).toBe(2);
    expect(components.schemas.PostsCreateResponse).toEqual(withTitleProperty);
    expect(components.schemas.AuthorsCreateResponse).toEqual(withoutTitleProperty);
  });

  test("merging the same parts array twice does not mutate the caller's parts or produce dangling $refs", () => {
    const part = buildOpenApiPartForHttp(
      contract({
        id: "auth.sign-in.email",
        path: "/api/auth/sign-in/email",
        requestBody: { type: "object", properties: { email: { type: "string" } } },
        cases: [{ key: "ok", status: 200 }],
      }) as any,
    ) as Record<string, unknown>;
    const inlineSchemaBefore = JSON.stringify(
      (part.paths as any)["/api/auth/sign-in/email"].post.requestBody.content["application/json"].schema,
    );

    const first = mergeOpenApiParts([part]);
    // The ORIGINAL part must be untouched by the first merge.
    expect(
      JSON.stringify(
        (part.paths as any)["/api/auth/sign-in/email"].post.requestBody.content["application/json"].schema,
      ),
    ).toBe(inlineSchemaBefore);

    // Merging the SAME parts array again must reproduce the same hoisted
    // document — not silently degrade to a dangling $ref with no
    // components.schemas backing it (codex R1 P2).
    const second = mergeOpenApiParts([part]);
    expect(second.components).toEqual(first.components);
    expect(second.paths).toEqual(first.paths);
  });

  // codex R2 P2/P3 — regression coverage for both findings.

  test("an explicit title on a LATER occurrence of a shared schema still wins the component name (naming is not traversal-order-dependent)", () => {
    const shape = { type: "object", properties: { message: { type: "string" } } };
    const untitled = { ...shape };
    const titled = { ...shape, title: "ErrorResponse" };

    // Sorted path traversal visits "/api/auth/sign-in/email" (untitled)
    // BEFORE "/api/auth/sign-up/email" (titled) — the untitled occurrence
    // is collected first.
    const partA = buildOpenApiPartForHttp(
      contract({
        id: "auth.sign-in.email",
        path: "/api/auth/sign-in/email",
        cases: [{ key: "badCreds", status: 401, responseBody: untitled }],
      }) as any,
    );
    const partB = buildOpenApiPartForHttp(
      contract({
        id: "auth.sign-up.email",
        path: "/api/auth/sign-up/email",
        cases: [{ key: "badInput", status: 400, responseBody: titled }],
      }) as any,
    );
    const doc = mergeOpenApiParts([partA!, partB!]);
    const components = doc.components as { schemas: Record<string, unknown> };

    // The explicit title wins regardless of which occurrence carried it —
    // NOT the derived "AuthSignInEmailResponse401" from the first-seen part.
    expect(Object.keys(components.schemas)).toEqual(["ErrorResponse"]);

    const refA = ((doc.paths as any)["/api/auth/sign-in/email"].post.responses["401"]
      .content["application/json"].schema) as { $ref: string };
    const refB = ((doc.paths as any)["/api/auth/sign-up/email"].post.responses["400"]
      .content["application/json"].schema) as { $ref: string };
    expect(refA.$ref).toBe("#/components/schemas/ErrorResponse");
    expect(refB.$ref).toBe("#/components/schemas/ErrorResponse");
  });

  test("a schema title that sanitizes to a dangerous key (__proto__) still lands as a real, retrievable component", () => {
    const part = buildOpenApiPartForHttp(
      contract({
        id: "danger.probe",
        path: "/danger",
        method: "GET",
        cases: [
          {
            key: "ok",
            status: 200,
            responseBody: {
              type: "object",
              title: "__proto__",
              properties: { x: { type: "string" } },
            },
          },
        ],
      }) as any,
    );
    const doc = mergeOpenApiParts([part!]);
    const components = doc.components as { schemas: Record<string, unknown> };

    // An own, enumerable "__proto__" component — not a hijacked prototype.
    expect(Object.prototype.hasOwnProperty.call(components.schemas, "__proto__")).toBe(true);
    expect(Object.keys(components.schemas)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(components.schemas)).toBe(null);

    const ref = (doc.paths as any)["/danger"].get.responses["200"].content["application/json"]
      .schema as { $ref: string };
    expect(ref.$ref).toBe("#/components/schemas/__proto__");
  });

  // codex R3 P2/P3 — regression coverage for both findings.

  test("root-level union/nullable (anyOf) and record (additionalProperties) body schemas are hoisted too", () => {
    const nullableUnion = {
      anyOf: [
        { type: "object", properties: { id: { type: "string" } } },
        { type: "null" },
      ],
    };
    const record = {
      type: "object",
      additionalProperties: { type: "number" },
    };
    const partUnion = buildOpenApiPartForHttp(
      contract({
        id: "widgets.maybeGet",
        path: "/widgets/maybe",
        method: "GET",
        cases: [{ key: "ok", status: 200, responseBody: nullableUnion }],
      }) as any,
    );
    const partRecord = buildOpenApiPartForHttp(
      contract({
        id: "widgets.counts",
        path: "/widgets/counts",
        method: "GET",
        cases: [{ key: "ok", status: 200, responseBody: record }],
      }) as any,
    );
    const doc = mergeOpenApiParts([partUnion!, partRecord!]);
    const components = doc.components as { schemas: Record<string, unknown> };

    expect(components.schemas).toHaveProperty("WidgetsMaybeGetResponse");
    expect(components.schemas).toHaveProperty("WidgetsCountsResponse");
    expect((doc.paths as any)["/widgets/maybe"].get.responses["200"].content["application/json"].schema).toEqual(
      { $ref: "#/components/schemas/WidgetsMaybeGetResponse" },
    );
  });

  test("a wildcard object (no properties, additionalProperties: true) still stays inline — record detection doesn't over-hoist", () => {
    const part = buildOpenApiPartForHttp(
      contract({
        id: "widgets.wildcard",
        path: "/widgets/wild",
        method: "GET",
        cases: [
          {
            key: "ok",
            status: 200,
            responseBody: { type: "object", additionalProperties: true },
          },
        ],
      }) as any,
    );
    const doc = mergeOpenApiParts([part!]);
    expect(doc.components).toBeUndefined();
  });

  test("two DIFFERENT schemas with the SAME explicit title get a deterministic numeric suffix, not a surprising alt name", () => {
    const partA = buildOpenApiPartForHttp(
      contract({
        id: "auth.sign-in.email",
        path: "/api/auth/sign-in/email",
        cases: [
          {
            key: "badCreds",
            status: 401,
            responseBody: {
              type: "object",
              title: "ErrorResponse",
              properties: { message: { type: "string" } },
            },
          },
        ],
      }) as any,
    );
    const partB = buildOpenApiPartForHttp(
      contract({
        id: "billing.charge",
        path: "/billing/charge",
        cases: [
          {
            key: "declined",
            status: 402,
            responseBody: {
              type: "object",
              title: "ErrorResponse",
              // Deliberately a DIFFERENT shape from partA's ErrorResponse —
              // same title, different content, so this must NOT dedupe.
              properties: { reason: { type: "string" }, retryable: { type: "boolean" } },
            },
          },
        ],
      }) as any,
    );
    const doc = mergeOpenApiParts([partA!, partB!]);
    const components = doc.components as { schemas: Record<string, unknown> };

    expect(Object.keys(components.schemas).sort()).toEqual(["ErrorResponse", "ErrorResponse_2"]);
    // NOT the status-suffixed derived alt-name ("BillingChargeResponse402") —
    // the explicit title collision falls through to the numeric suffix.
    expect(components.schemas).not.toHaveProperty("BillingChargeResponse402");
  });
});
