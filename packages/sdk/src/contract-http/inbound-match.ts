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

import type {
  InboundDelivery,
  InboundMatchResult,
} from "../contract-types.js";
import type { SchemaLike, SecretsAccessor } from "../types.js";
import type { InboundContractCase } from "./types.js";
import { isInboundCase } from "./types.js";
import { getSignatureVerifier } from "./inbound-verify.js";
import { resolvePath } from "../contract-flow-condition.js";

export interface MatchInboundInput {
  caseSpec: unknown;
  delivery: InboundDelivery;
  secrets: SecretsAccessor;
  /**
   * `eventPath` is the EXTRACTED selector path (builder-gated), not the lens:
   * walking a path is shape-safe — an unrelated body without the path yields
   * `undefined` → type-mismatch probe, where calling `e => e.data.id` would
   * throw and wrongly fail the node (codex I3 R1 P2).
   */
  correlate?: { eventPath: readonly string[]; stateValue: unknown };
}

/**
 * Validate a parsed body against the case's SchemaLike, PRESERVING the
 * schema's output — transforms/coercions/strips/defaults must reach the
 * poll's `out` lens, same as the HTTP response validation path (codex I3
 * R2 P2). `parse()` fallback returns its result for the same reason.
 */
function applySchema(
  schema: SchemaLike<unknown>,
  value: unknown,
): { ok: true; data: unknown } | { ok: false } {
  if (typeof schema.safeParse === "function") {
    const r = schema.safeParse(value);
    return r.success ? { ok: true, data: r.data } : { ok: false };
  }
  if (typeof schema.parse === "function") {
    try {
      return { ok: true, data: schema.parse(value) };
    } catch {
      return { ok: false };
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

/**
 * Preflight (§9.4 row P): validate config WITHOUT a delivery — bad config
 * must never hide as a probe or, with an empty inbox, exhaust as a timeout
 * (codex I3 R3 P2). The poll calls this each attempt before reading the
 * receiver; the matcher reuses it so direct callers get the same guarantee.
 */
export function preflightInboundCaseHttp(input: {
  caseSpec: unknown;
  secrets: SecretsAccessor;
}): {
  c: InboundContractCase;
  verifier?: ReturnType<typeof getSignatureVerifier>;
  secret?: string;
} {
  const { caseSpec, secrets } = input;
  if (!isInboundCase(caseSpec)) {
    throw new Error(
      "matchInboundCase: case is not an inbound case — the workflow inbound " +
        "poll only dispatches refs with direction: \"inbound\".",
    );
  }
  const c = caseSpec as InboundContractCase;
  const sig = c.expect.signature;
  if (!sig) return { c };
  const verifier = getSignatureVerifier(sig.scheme);
  if (!verifier) {
    throw new Error(
      `inbound case: unknown signature scheme "${sig.scheme}" — not in the ` +
        `verifier registry (built-ins: stripe-v1, hmac-sha256; plugins ` +
        `register via registerSignatureVerifier).`,
    );
  }
  // Throws when missing — exactly the preflight semantics we want.
  return { c, verifier, secret: secrets.require(sig.secretRef) };
}

export function matchInboundCaseHttp(input: MatchInboundInput): InboundMatchResult {
  const { delivery, correlate } = input;
  const { c, verifier, secret } = preflightInboundCaseHttp(input);
  const sig = c.expect.signature;

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
      // Staleness is measured at RECEIPT, not at poll time — a pre-existing
      // valid delivery must not turn stale because the poll started late
      // (allowed evidence, §9.4a #3; codex I3 R2 P2).
      nowMs: delivery.receivedAt,
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
    const eventValue = resolvePath(parsed, correlate.eventPath);
    if (eventValue === undefined) return { kind: "type-mismatch" };
    if (eventValue !== correlate.stateValue) return { kind: "correlation-mismatch" };
    // Instance attributed — shape violations classify as schema-mismatch
    // for diagnosis, but stay probes (consult #2).
    const validated = applySchema(c.expect.bodySchema, parsed);
    if (!validated.ok || !headersAccept(c, delivery)) {
      return { kind: "schema-mismatch" };
    }
    return { kind: "matched", parsed: validated.data };
  }

  // Without correlate, bodySchema (+ header matchers) IS the positive
  // matcher; a non-fitting body is indistinguishable from someone else's
  // event (§9.4a) — type-mismatch, keep waiting.
  const validated = applySchema(c.expect.bodySchema, parsed);
  if (!validated.ok || !headersAccept(c, delivery)) {
    return { kind: "type-mismatch" };
  }
  return { kind: "matched", parsed: validated.data };
}
