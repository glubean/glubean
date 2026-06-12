/**
 * matchInboundCase — classify ONE delivery against an inbound HTTP case
 * (inbound-contract-design §9.4/§9.4a).
 *
 * v1 principle: **authentication decides failure; content decides
 * attribution.** Fail-class results (signature-invalid / stale /
 * unparseable) are properties of the DELIVERY CHANNEL; every content-level
 * mismatch (type / correlation / schema) is a probe whose label exists for
 * poll_attempt diagnosis, never for verdict — same-instance
 * different-event-type deliveries are normal in event streams
 * (consult #2), so a hard content fail would misfire on them.
 */

import type { InboundDelivery, InboundMatchResult } from "../contract-types.js";
import type { SchemaLike, SecretsAccessor } from "../types.js";
import type { InboundContractCase } from "./types.js";
import { isInboundCase } from "./types.js";
import { getSignatureVerifier } from "./inbound-verify.js";

export interface MatchInboundInput {
  caseSpec: unknown;
  delivery: InboundDelivery;
  secrets: SecretsAccessor;
  correlate?: { eventLens: (event: unknown) => unknown; stateValue: unknown };
  nowMs: number;
}

/** Validate a parsed body against the case's SchemaLike. */
function schemaAccepts(schema: SchemaLike<unknown>, value: unknown): boolean {
  if (typeof schema.safeParse === "function") {
    return schema.safeParse(value).success;
  }
  if (typeof schema.parse === "function") {
    try {
      schema.parse(value);
      return true;
    } catch {
      return false;
    }
  }
  // A schema with neither method can never accept — surface as config error
  // rather than silently matching everything.
  throw new Error(
    "inbound case bodySchema has neither safeParse nor parse — not a SchemaLike",
  );
}

/** expect.headers static matchers ({present:true} | {eq}) over lowercased headers. */
function headersAccept(c: InboundContractCase, delivery: InboundDelivery): boolean {
  const expected = c.expect.headers;
  if (!expected) return true;
  for (const [name, matcher] of Object.entries(expected)) {
    const actual = delivery.headers[name.toLowerCase()];
    if ("present" in matcher) {
      if (actual === undefined) return false;
    } else if (actual !== matcher.eq) {
      return false;
    }
  }
  return true;
}

export function matchInboundCaseHttp(input: MatchInboundInput): InboundMatchResult {
  const { caseSpec, delivery, secrets, correlate, nowMs } = input;
  if (!isInboundCase(caseSpec)) {
    throw new Error(
      "matchInboundCase: case is not an inbound case — the workflow inbound " +
        "poll only dispatches refs with direction: \"inbound\".",
    );
  }
  const c = caseSpec as InboundContractCase;

  // ── Preflight (§9.4 row P): bad config must never hide as a probe ──────
  const sig = c.expect.signature;
  let verifier;
  let secret: string | undefined;
  if (sig) {
    verifier = getSignatureVerifier(sig.scheme);
    if (!verifier) {
      throw new Error(
        `inbound case: unknown signature scheme "${sig.scheme}" — not in the ` +
          `verifier registry (built-ins: stripe-v1, hmac-sha256; plugins ` +
          `register via registerSignatureVerifier).`,
      );
    }
    // Throws when missing — exactly the preflight semantics we want.
    secret = secrets.require(sig.secretRef);
  }

  // ── Authentication first (§9.4 rows 1–2) ───────────────────────────────
  if (sig && verifier && secret !== undefined) {
    const headerValue = delivery.headers[sig.header.toLowerCase()];
    if (headerValue === undefined) {
      return { kind: "signature-invalid", detail: `header "${sig.header}" missing` };
    }
    const result = verifier.verify({
      bodyBytes: delivery.bodyBytes,
      headerValue,
      secret,
      toleranceMs: sig.toleranceMs,
      nowMs,
    });
    if (!result.ok) return { kind: result.reason };
  }

  // ── Parse (§9.4 row 3) — authenticated but not JSON = promise violated ─
  let parsed: unknown;
  try {
    parsed = JSON.parse(delivery.rawBody);
  } catch {
    return { kind: "unparseable" };
  }

  // ── Content: attribution only (§9.4a rows 4–6, all probes) ─────────────
  if (correlate) {
    const eventValue = correlate.eventLens(parsed);
    if (eventValue === undefined) return { kind: "type-mismatch" };
    if (eventValue !== correlate.stateValue) return { kind: "correlation-mismatch" };
    // Instance attributed — shape violations classify as schema-mismatch
    // for diagnosis, but stay probes (consult #2).
    if (!schemaAccepts(c.expect.bodySchema, parsed) || !headersAccept(c, delivery)) {
      return { kind: "schema-mismatch" };
    }
    return { kind: "matched", parsed };
  }

  // Without correlate, bodySchema (+ header matchers) IS the positive
  // matcher; a non-fitting body is indistinguishable from someone else's
  // event (§9.4a) — type-mismatch, keep waiting.
  if (!schemaAccepts(c.expect.bodySchema, parsed) || !headersAccept(c, delivery)) {
    return { kind: "type-mismatch" };
  }
  return { kind: "matched", parsed };
}
