/**
 * I3 — matchInboundCase classification matrix (inbound-contract-design
 * §9.4/§9.4a). The contract under test: authentication decides failure;
 * content decides attribution (every content mismatch is a probe).
 */

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { matchInboundCaseHttp } from "./inbound-match.js";
import { inboundCase } from "./types.js";
import type { InboundDelivery } from "../contract-types.js";
import type { SecretsAccessor } from "../types.js";

const enc = new TextEncoder();

const makeDelivery = (body: string, headers: Record<string, string> = {}): InboundDelivery => ({
  id: "d-1",
  bodyBytes: enc.encode(body),
  rawBody: body,
  headers,
  method: "POST",
  path: "/",
  receivedAt: 1000,
});

const secrets = {
  require: (name: string) => {
    if (name === "WH_SECRET") return "whsec_test";
    throw new Error(`Secret "${name}" is not set`);
  },
  get: (name: string) => (name === "WH_SECRET" ? "whsec_test" : undefined),
} as unknown as SecretsAccessor;

/** Discriminating schema: accepts only type === "created" events. */
const createdSchema = {
  safeParse: (d: unknown) => {
    const ok = !!d && typeof d === "object" && (d as { type?: unknown }).type === "created";
    return ok
      ? { success: true as const, data: d }
      : { success: false as const, error: { issues: [{ message: "wrong type" }] } };
  },
};

const plainCase = inboundCase({ description: "d", expect: { bodySchema: createdSchema } });
const match = (
  caseSpec: unknown,
  delivery: InboundDelivery,
  correlate?: { eventPath: readonly string[]; stateValue: unknown },
) => matchInboundCaseHttp({ caseSpec, delivery, secrets, correlate });

describe("preflight (§9.4 row P) — bad config never hides as a probe", () => {
  it("unknown verifier scheme throws", () => {
    const c = inboundCase({
      description: "d",
      expect: {
        bodySchema: createdSchema,
        signature: { scheme: "nope-v9", header: "x-sig", secretRef: "WH_SECRET" },
      },
    });
    expect(() => match(c, makeDelivery("{}"))).toThrow(/unknown signature scheme "nope-v9"/);
  });

  it("missing secret throws (secrets.require propagates)", () => {
    const c = inboundCase({
      description: "d",
      expect: {
        bodySchema: createdSchema,
        signature: { scheme: "hmac-sha256", header: "x-sig", secretRef: "ABSENT" },
      },
    });
    expect(() => match(c, makeDelivery("{}"))).toThrow(/Secret "ABSENT" is not set/);
  });

  it("a non-inbound case spec is a dispatch bug — throws", () => {
    expect(() => match({ description: "outbound", expect: { status: 200 } }, makeDelivery("{}")))
      .toThrow(/not an inbound case/);
  });
});

describe("authentication first (§9.4 rows 1–3)", () => {
  const signedCase = inboundCase({
    description: "d",
    expect: {
      bodySchema: createdSchema,
      signature: { scheme: "hmac-sha256", header: "x-sig", secretRef: "WH_SECRET" },
    },
  });
  const sign = (body: string) => createHmac("sha256", "whsec_test").update(body).digest("hex");

  it("missing signature header → signature-invalid (never a probe)", () => {
    const r = match(signedCase, makeDelivery('{"type":"created"}'));
    expect(r).toEqual({ kind: "signature-invalid", detail: 'header "x-sig" missing' });
  });

  it("forged signature → signature-invalid even when the body would match", () => {
    const r = match(signedCase, makeDelivery('{"type":"created"}', { "x-sig": "0".repeat(64) }));
    expect(r.kind).toBe("signature-invalid");
  });

  it("valid signature + matching body → matched with the parsed body", () => {
    const body = '{"type":"created"}';
    const r = match(signedCase, makeDelivery(body, { "x-sig": sign(body) }));
    expect(r).toEqual({ kind: "matched", parsed: { type: "created" } });
  });

  it("staleness clock is RECEIPT time, not poll time (codex R2): an early valid delivery never turns stale", () => {
    const t = 1_700_000_000; // signature timestamp (unix seconds)
    const body = '{"type":"created"}';
    const stripeCase = inboundCase({
      description: "d",
      expect: {
        bodySchema: createdSchema,
        signature: { scheme: "stripe-v1", header: "stripe-signature", secretRef: "WH_SECRET" },
      },
    });
    const v1 = createHmac("sha256", "whsec_test").update(`${t}.${body}`).digest("hex");
    const header = { "stripe-signature": `t=${t},v1=${v1}` };
    // Received within tolerance of its own timestamp — matched, no matter how
    // long ago that was relative to "now" (the matcher never reads Date.now()).
    const fresh: InboundDelivery = { ...makeDelivery(body, header), receivedAt: t * 1000 + 1000 };
    expect(match(stripeCase, fresh).kind).toBe("matched");
    // Received OUTSIDE tolerance of its timestamp — replay suspicion → stale.
    const replayed: InboundDelivery = { ...makeDelivery(body, header), receivedAt: t * 1000 + 600_000 };
    expect(match(stripeCase, replayed).kind).toBe("stale");
  });

  it("authenticated but non-JSON → unparseable (promise violated)", () => {
    const body = "not json {";
    const r = match(signedCase, makeDelivery(body, { "x-sig": sign(body) }));
    expect(r.kind).toBe("unparseable");
  });
});

describe("content = attribution only (§9.4a rows 4–6, all probes)", () => {
  it("without correlate: non-fitting body → type-mismatch (someone else's event)", () => {
    expect(match(plainCase, makeDelivery('{"type":"succeeded"}')).kind).toBe("type-mismatch");
  });

  it("without correlate: header matcher miss → type-mismatch", () => {
    const c = inboundCase({
      description: "d",
      expect: { bodySchema: createdSchema, headers: { "content-type": { eq: "application/json" } } },
    });
    const r = match(c, makeDelivery('{"type":"created"}', { "content-type": "text/plain" }));
    expect(r.kind).toBe("type-mismatch");
  });

  it("with correlate: missing path → type-mismatch, NEVER a throw (codex R1)", () => {
    // The R1 scenario: a direct `e => e.data.id` lens would THROW on a body
    // without `data`; the safe path walk classifies instead.
    const r = match(plainCase, makeDelivery('{"type":"created"}'), {
      eventPath: ["data", "id"],
      stateValue: "pi_1",
    });
    expect(r.kind).toBe("type-mismatch");
    // Deeper unrelated shapes too — `data` present but not an object.
    const r2 = match(plainCase, makeDelivery('{"type":"created","data":42}'), {
      eventPath: ["data", "id", "nested"],
      stateValue: "pi_1",
    });
    expect(r2.kind).toBe("type-mismatch");
  });

  it("with correlate: value differs → correlation-mismatch (sibling run)", () => {
    const r = match(plainCase, makeDelivery('{"type":"created","data":{"id":"pi_OTHER"}}'), {
      eventPath: ["data", "id"],
      stateValue: "pi_1",
    });
    expect(r.kind).toBe("correlation-mismatch");
  });

  it("with correlate: instance attributed but wrong event type → schema-mismatch, STILL a probe kind", () => {
    // The §9.4a #2 scenario: payment_intent.succeeded for OUR object while we
    // wait for created — attribution says ours, shape says another event.
    const r = match(plainCase, makeDelivery('{"type":"succeeded","data":{"id":"pi_1"}}'), {
      eventPath: ["data", "id"],
      stateValue: "pi_1",
    });
    expect(r.kind).toBe("schema-mismatch");
  });

  it("matched preserves the SCHEMA OUTPUT — transforms/defaults reach `out` (codex R2)", () => {
    const transforming = inboundCase({
      description: "d",
      expect: {
        bodySchema: {
          // Strips unknown keys + defaults a field — the validated shape, not raw JSON.
          safeParse: (d: unknown) => {
            const o = d as { type?: string };
            return o?.type === "created"
              ? { success: true as const, data: { type: o.type, amount: 0 } }
              : { success: false as const, error: { issues: [{ message: "no" }] } };
          },
        },
      },
    });
    const r = match(transforming, makeDelivery('{"type":"created","junk":"x"}'));
    expect(r).toEqual({ kind: "matched", parsed: { type: "created", amount: 0 } });
  });

  it("with correlate: attributed + fitting → matched", () => {
    const c = inboundCase({
      description: "d",
      expect: {
        bodySchema: {
          safeParse: (d: unknown) => ({ success: true as const, data: d }),
        },
      },
    });
    const r = match(c, makeDelivery('{"type":"created","data":{"id":"pi_1"}}'), {
      eventPath: ["data", "id"],
      stateValue: "pi_1",
    });
    expect(r.kind).toBe("matched");
  });
});
