/**
 * I2 — inbound contract cases (inbound-contract-design §9.2/§9.5).
 *
 * Scope: authoring (inboundCase in the cases map), construction-time
 * validation, projection/normalize with the direction marker, the
 * "never runnable / never executable" guarantees, and ref-direction guards
 * on every outbound-consuming entry point.
 */

import { test, expect, beforeEach } from "vitest";
// Main index so the HTTP adapter side-effect registration fires.
import { contract, inboundCase, isInboundCase, workflow } from "../index.js";
import { httpAdapter } from "./adapter.js";
import { buildOpenApiPartForHttp } from "./openapi.js";
import {
  markdownArtifact,
  openapiArtifact,
  renderArtifact,
  renderArtifactWithSummary,
} from "../contract-artifacts.js";
import type {
  HttpContractSpec,
  HttpPayloadSchemas,
  HttpContractMeta,
  HttpSafeSchemas,
} from "./types.js";
import type { ProtocolContract } from "../contract-types.js";
import type { HttpClient, TestContext } from "../types.js";
import { clearRegistry, getRegistry } from "../internal.js";
import { clearBootstrapRegistry } from "../bootstrap-registry.js";

beforeEach(() => {
  clearRegistry();
  clearBootstrapRegistry();
});

/** Projectable fake schema (schemaToJsonSchema uses `toJSONSchema()`). */
const eventSchema = {
  safeParse: (d: unknown) => ({ success: true as const, data: d }),
  toJSONSchema: () => ({ type: "object", properties: { id: { type: "string" } } }),
};

const makeApi = () => contract.http.with("api", {});

const stripeContract = () =>
  makeApi()("stripe.webhooks", {
    endpoint: "POST /webhooks/stripe",
    cases: {
      ack: {
        description: "we ACK the delivery",
        expect: { status: 200 },
      },
      paymentIntentCreated: inboundCase({
        description: "Stripe posts payment_intent.created, signed",
        expect: {
          bodySchema: eventSchema,
          headers: { "content-type": { eq: "application/json" } },
          signature: {
            scheme: "stripe-v1",
            header: "stripe-signature",
            secretRef: "WEBHOOK_SECRET",
            toleranceMs: 60_000,
          },
          within: 60_000,
        },
      }),
    },
  }) as ProtocolContract<HttpContractSpec, HttpPayloadSchemas, HttpContractMeta>;

// ---------------------------------------------------------------------------
// Authoring + branding
// ---------------------------------------------------------------------------

test("inboundCase() brands direction; isInboundCase discriminates", () => {
  const c = inboundCase({ description: "d", expect: { bodySchema: eventSchema } });
  expect(c.direction).toBe("inbound");
  expect(isInboundCase(c)).toBe(true);
  expect(isInboundCase({ description: "outbound", expect: { status: 200 } })).toBe(false);
});

test("inbound case registers NO Test and NO runnable-inventory entry (§9.5)", () => {
  const c = stripeContract();
  // Only the outbound case becomes a Test on the contract array…
  expect(c.length).toBe(1);
  expect(c[0].meta.id).toBe("stripe.webhooks.ack");
  // …and only the outbound case enters the runnable registry.
  const ids = getRegistry().map((t) => t.id);
  expect(ids).toContain("stripe.webhooks.ack");
  expect(ids).not.toContain("stripe.webhooks.paymentIntentCreated");
});

// ---------------------------------------------------------------------------
// Projection + normalize
// ---------------------------------------------------------------------------

test("projection carries direction/runnable + the inbound promise; secretRef stays a NAME", () => {
  const c = stripeContract();
  const projCase = c._projection.cases.find((x) => x.key === "paymentIntentCreated")!;
  expect(projCase.direction).toBe("inbound");
  expect(projCase.runnable).toBe(false);
  const live = (projCase.schemas as HttpPayloadSchemas).inbound!;
  expect(live.body).toBe(eventSchema);
  expect(live.signature).toEqual({
    scheme: "stripe-v1",
    header: "stripe-signature",
    secretRef: "WEBHOOK_SECRET", // a NAME — never a resolved value
    toleranceMs: 60_000,
  });
  expect(live.within).toBe(60_000);

  const extracted = c._extracted.cases.find((x) => x.key === "paymentIntentCreated")!;
  expect(extracted.direction).toBe("inbound");
  expect(extracted.runnable).toBe(false);
  const safe = (extracted.schemas as HttpSafeSchemas).inbound!;
  expect(safe.body).toEqual({
    type: "object",
    properties: { id: { type: "string" } },
  });
  expect(safe.headers).toEqual({ "content-type": { eq: "application/json" } });
  expect(safe.signature?.secretRef).toBe("WEBHOOK_SECRET");
  // Outbound case is unaffected.
  const ack = c._extracted.cases.find((x) => x.key === "ack")!;
  expect(ack.direction).toBeUndefined();
  expect(ack.runnable).toBeUndefined();
});

test("errorEnvelope defaults never touch inbound cases", () => {
  const envelope = {
    safeParse: (d: unknown) => ({ success: true as const, data: d }),
    toJSONSchema: () => ({ type: "object" }),
  };
  const api = contract.http.with("api", { errorEnvelope: envelope });
  const c = api("evt", {
    endpoint: "POST /hooks",
    cases: {
      bad: { description: "rejects", expect: { status: 400 } },
      evt: inboundCase({ description: "evt", expect: { bodySchema: eventSchema } }),
    },
  }) as ProtocolContract<HttpContractSpec, HttpPayloadSchemas, HttpContractMeta>;
  // Outbound non-2xx case got the envelope; inbound expect is untouched.
  const bad = c._spec.cases.bad as { expect: { schema?: unknown } };
  expect(bad.expect.schema).toBe(envelope);
  const evt = c._spec.cases.evt as unknown as { expect: Record<string, unknown> };
  expect(evt.expect.schema).toBeUndefined();
  expect(evt.expect.bodySchema).toBe(eventSchema);
});

// ---------------------------------------------------------------------------
// Construction-time validation
// ---------------------------------------------------------------------------

const buildWith = (caseSpec: Record<string, unknown>) => () =>
  makeApi()("c", {
    endpoint: "POST /hooks",
    cases: { evt: { direction: "inbound", description: "d", ...caseSpec } as never },
  });

test("outbound-only fields are rejected with field-specific errors", () => {
  expect(buildWith({ expect: { bodySchema: eventSchema }, body: { x: 1 } }))
    .toThrow(/"body" is not allowed on an inbound case/);
  expect(buildWith({ expect: { bodySchema: eventSchema }, verify: async () => {} }))
    .toThrow(/"verify" is not allowed/);
  expect(buildWith({ expect: { bodySchema: eventSchema }, needs: eventSchema }))
    .toThrow(/"needs" is not allowed/);
  expect(buildWith({ expect: { bodySchema: eventSchema }, headers: { a: "b" } }))
    .toThrow(/header EXPECTATIONS go in expect\.headers/);
});

test("expect shape is validated: bodySchema required, status/schema rejected", () => {
  expect(buildWith({ expect: {} })).toThrow(/expect\.bodySchema is required/);
  expect(buildWith({})).toThrow(/expect\.bodySchema is required/);
  expect(buildWith({ expect: { bodySchema: eventSchema, status: 200 } }))
    .toThrow(/outbound response vocabulary/);
});

test("header matchers and signature/within shapes are validated", () => {
  expect(buildWith({ expect: { bodySchema: eventSchema, headers: { h: { gt: 3 } } } }))
    .toThrow(/must be \{ present: true \} or \{ eq:/);
  expect(
    buildWith({
      expect: {
        bodySchema: eventSchema,
        signature: { scheme: "stripe-v1", header: "stripe-signature", secretRef: "" },
      },
    }),
  ).toThrow(/signature\.secretRef must be a non-empty string/);
  expect(
    buildWith({
      expect: {
        bodySchema: eventSchema,
        signature: {
          scheme: "stripe-v1",
          header: "stripe-signature",
          secretRef: "S",
          toleranceMs: -1,
        },
      },
    }),
  ).toThrow(/toleranceMs must be a positive number/);
  expect(buildWith({ expect: { bodySchema: eventSchema, within: 0 } }))
    .toThrow(/within must be a positive number/);
});

// ---------------------------------------------------------------------------
// Never executable: ref guards on every outbound-consuming entry point
// ---------------------------------------------------------------------------

test(".case() ref carries direction; call/poll/flow-step/bootstrap all reject it", () => {
  const c = stripeContract();
  const ref = c.case("paymentIntentCreated");
  expect(ref.direction).toBe("inbound");
  expect(c.case("ack").direction).toBeUndefined();

  expect(() =>
    workflow("w").call("hit", ref),
  ).toThrow(/is inbound — the counterparty calls us/);
  // Inbound polling itself ships in I3 — an inbound ref IS accepted by
  // .poll, but only with the inbound vocabulary (until is outbound).
  expect(() =>
    workflow("w").poll("wait", ref, { until: { ok: { eq: [(s: unknown) => s, true] } } } as never),
  ).toThrow(/`until` is not allowed on an inbound poll/);
  expect(() =>
    contract.flow("f").step(ref),
  ).toThrow(/is inbound/);
  expect(() =>
    contract.bootstrap(ref, async () => undefined),
  ).toThrow(/a bootstrap[\s\S]*overlay has no meaning/);
});

test("adapter execution entry points fail fast on inbound case specs", async () => {
  const c = stripeContract();
  const caseSpec = c._spec.cases.paymentIntentCreated;
  await expect(
    httpAdapter.execute({} as TestContext, caseSpec as never, c._spec),
  ).rejects.toThrow(/inbound case cannot be executed/);
  await expect(
    httpAdapter.executeCase!({
      ctx: {} as TestContext,
      contract: c as never,
      caseKey: "paymentIntentCreated",
      resolvedInput: undefined,
    }),
  ).rejects.toThrow(/inbound case cannot be executed/);
  await expect(
    httpAdapter.executeCaseInFlow!({
      ctx: {} as TestContext,
      contract: c as never,
      caseKey: "paymentIntentCreated",
      resolvedInputs: undefined,
    }) as Promise<unknown>,
  ).rejects.toThrow(/is inbound/);
});

// ---------------------------------------------------------------------------
// OpenAPI (codex I2 R1 P2): no fabricated 200 for inbound promises
// ---------------------------------------------------------------------------

test("OpenAPI: inbound cases never fabricate responses; direction rides x-glubean-cases", () => {
  const api = makeApi();
  const c = api("stripe.webhooks", {
    endpoint: "POST /webhooks/stripe",
    cases: {
      ack: { description: "we ACK", expect: { status: 201 } },
      evt: inboundCase({ description: "signed event", expect: { bodySchema: eventSchema } }),
    },
  }) as ProtocolContract<HttpContractSpec, HttpPayloadSchemas, HttpContractMeta>;
  const part = buildOpenApiPartForHttp(c._extracted as never)!;
  const op = (part.paths as Record<string, Record<string, Record<string, unknown>>>)[
    "/webhooks/stripe"
  ].post;
  // Only the outbound case contributes a response — no dummy 200 from `evt`.
  expect(Object.keys(op.responses as Record<string, unknown>)).toEqual(["201"]);
  const cases = op["x-glubean-cases"] as Array<Record<string, unknown>>;
  const evt = cases.find((x) => x.key === "evt")!;
  expect(evt.direction).toBe("inbound");
  expect(evt.description).toBe("signed event");
  const ack = cases.find((x) => x.key === "ack");
  expect(ack?.direction).toBeUndefined();
});

test("OpenAPI: an inbound-only contract emits NO path (null part, not a fake operation)", () => {
  const api = makeApi();
  const c = api("stripe.webhooks.inonly", {
    endpoint: "POST /webhooks/stripe",
    cases: {
      evt: inboundCase({ description: "signed event", expect: { bodySchema: eventSchema } }),
    },
  }) as ProtocolContract<HttpContractSpec, HttpPayloadSchemas, HttpContractMeta>;
  expect(buildOpenApiPartForHttp(c._extracted as never)).toBeNull();
});

// ---------------------------------------------------------------------------
// Markdown (inbound-artifact-design route C) + null-part pipeline (D6)
// ---------------------------------------------------------------------------

test("markdown renders the inbound promise: 📥 marker, signature, withinMs, summary facet", () => {
  const c = stripeContract();
  const doc = renderArtifact(markdownArtifact, [c._extracted as never]);
  expect(doc).toContain("📥 **paymentIntentCreated**");
  expect(doc).toContain(
    "signed: stripe-v1 via `stripe-signature` (secret: WEBHOOK_SECRET, tolerance 60000ms)",
  );
  expect(doc).toContain("within: 60000ms");
  expect(doc).toContain("1 inbound");
  // The outbound sibling renders without the inbound marker.
  expect(doc).toMatch(/- \*\*ack\*\*/);
});

test("inbound-only contract: openapi producer returns null → recorded skip, NOT an empty part (D6)", () => {
  const api = makeApi();
  const c = api("hooks.inonly", {
    endpoint: "POST /hooks",
    cases: {
      evt: inboundCase({ description: "evt", expect: { bodySchema: eventSchema } }),
    },
  }) as ProtocolContract<HttpContractSpec, HttpPayloadSchemas, HttpContractMeta>;
  const summary = renderArtifactWithSummary(openapiArtifact, [c._extracted as never]);
  expect(summary.usedEmptyFallback).toBe(true); // zero parts — no fabricated {} reached merge
  expect(summary.skipped).toEqual([
    { contractId: "hooks.inonly", protocol: "http", reason: "producer-returned-null" },
  ]);
  expect(summary.contributions).toEqual([]);
});

test("inbound-only project: user OpenAPI options survive the zero-contribution render (codex C-R1 P2)", () => {
  const api = makeApi();
  const c = api("hooks.optonly", {
    endpoint: "POST /hooks",
    cases: {
      evt: inboundCase({ description: "evt", expect: { bodySchema: eventSchema } }),
    },
  }) as ProtocolContract<HttpContractSpec, HttpPayloadSchemas, HttpContractMeta>;
  const doc = renderArtifact(openapiArtifact, [c._extracted as never], {
    title: "My API",
    version: "2.1.0",
  });
  // merge([], options) ran — the document carries the user's info block.
  expect((doc as { info: { title: string; version: string } }).info).toMatchObject({
    title: "My API",
    version: "2.1.0",
  });
});

test("a deferred inbound case keeps its 📥 direction cue (codex C-R1 P3)", () => {
  const api = makeApi();
  const c = api("hooks.deferred", {
    endpoint: "POST /hooks",
    cases: {
      evt: inboundCase({
        description: "evt",
        deferred: "tunnel not provisioned yet",
        expect: { bodySchema: eventSchema },
      }),
    },
  }) as ProtocolContract<HttpContractSpec, HttpPayloadSchemas, HttpContractMeta>;
  const doc = renderArtifact(markdownArtifact, [c._extracted as never]);
  expect(doc).toContain("📥 ⊘ **evt** — deferred: tunnel not provisioned yet");
});

// ---------------------------------------------------------------------------
// Mixed-direction typing smoke (compile-time): inline outbound + helper inbound
// ---------------------------------------------------------------------------

test("mixed cases keep outbound flow typing intact", () => {
  const client = undefined as unknown as HttpClient;
  const api = contract.http.with("api", { client });
  const c = api("mixed", {
    endpoint: "POST /x",
    cases: {
      ok: { description: "ok", expect: { status: 200 } },
      evt: inboundCase({ description: "evt", expect: { bodySchema: eventSchema } }),
    },
  });
  // Outbound ref still constructs; inbound ref is marked.
  expect(c.case("ok").direction).toBeUndefined();
  expect(c.case("evt").direction).toBe("inbound");
});
