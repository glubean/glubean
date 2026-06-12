/**
 * Inbound signature verifiers — a pluggable registry keyed by scheme name.
 *
 * Design: inbound-contract-design §9.2/§9.4. The contract declares
 * `signature: { scheme, header, secretRef, toleranceMs? }`; the scheme is a
 * REGISTERED verifier name (projection-safe — only the name is ever
 * projected), and the matcher resolves `secretRef` → secret at run time and
 * hands this registry the EXACT received bytes.
 *
 * Verification order is authentication-first (design §9.4): validity is
 * checked before staleness, so an invalid signature classifies as
 * `signature-invalid` even when its timestamp is also outside tolerance.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Input to a signature verifier — bytes, never parsed bodies. */
export interface SignatureVerifyInput {
  /** EXACT body bytes as received (InboundDelivery.bodyBytes). */
  bodyBytes: Uint8Array;
  /** Raw value of the configured signature header. */
  headerValue: string;
  /** Resolved secret (from the case's secretRef) — never logged. */
  secret: string;
  /** Replay window for timestamped schemes (scheme-default when absent). */
  toleranceMs?: number;
  /** Injected clock (epoch ms) so staleness is testable. */
  nowMs: number;
}

export type SignatureVerifyResult =
  | { ok: true }
  | { ok: false; reason: "signature-invalid" | "stale" };

export interface SignatureVerifier {
  verify(input: SignatureVerifyInput): SignatureVerifyResult;
}

const registry = new Map<string, SignatureVerifier>();

/**
 * Register a verifier under a scheme name. Built-ins (`stripe-v1`,
 * `hmac-sha256`) are pre-registered; re-registering a name overwrites it
 * (last-write-wins, same as plugin adapters).
 */
export function registerSignatureVerifier(
  scheme: string,
  verifier: SignatureVerifier,
): void {
  registry.set(scheme, verifier);
}

/** Look up a verifier; undefined when the scheme was never registered. */
export function getSignatureVerifier(scheme: string): SignatureVerifier | undefined {
  return registry.get(scheme);
}

/** Constant-time hex comparison; length mismatch is just "not equal". */
function hexEquals(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, "hex");
  const b = Buffer.from(bHex, "hex");
  // Buffer.from("zz", "hex") silently truncates — re-encode to reject
  // non-hex input instead of comparing mangled bytes.
  if (a.toString("hex") !== aHex.toLowerCase() || b.toString("hex") !== bHex.toLowerCase()) {
    return false;
  }
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/**
 * `hmac-sha256` — plain HMAC-SHA256 over the raw body, hex-encoded in the
 * header. Accepts an optional `sha256=` prefix (GitHub's
 * `x-hub-signature-256` convention). No timestamp → never `stale`.
 */
const hmacSha256: SignatureVerifier = {
  verify({ bodyBytes, headerValue, secret }) {
    const expected = headerValue.startsWith("sha256=")
      ? headerValue.slice("sha256=".length)
      : headerValue;
    const actual = createHmac("sha256", secret).update(bodyBytes).digest("hex");
    return hexEquals(actual, expected)
      ? { ok: true }
      : { ok: false, reason: "signature-invalid" };
  },
};

/** stripe-v1 default replay window (Stripe docs recommend 5 minutes). */
export const STRIPE_V1_DEFAULT_TOLERANCE_MS = 300_000;

/**
 * `stripe-v1` — Stripe webhook signatures: header `t=<unix seconds>,
 * v1=<hex>[,v1=<hex>...]`; signed payload is `${t}.` + raw body bytes,
 * HMAC-SHA256 with the endpoint secret used as-is. Any matching `v1`
 * authenticates (Stripe sends multiples during secret rotation).
 * Authenticated-but-outside-tolerance → `stale` (design §9.4 row 2).
 */
const stripeV1: SignatureVerifier = {
  verify({ bodyBytes, headerValue, secret, toleranceMs, nowMs }) {
    let timestamp: number | undefined;
    const v1s: string[] = [];
    for (const part of headerValue.split(",")) {
      const eq = part.indexOf("=");
      if (eq === -1) continue;
      const key = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      if (key === "t") timestamp = Number(value);
      else if (key === "v1") v1s.push(value);
    }
    if (timestamp === undefined || !Number.isFinite(timestamp) || v1s.length === 0) {
      return { ok: false, reason: "signature-invalid" };
    }
    const signedPayload = Buffer.concat([
      Buffer.from(`${timestamp}.`, "utf8"),
      Buffer.from(bodyBytes),
    ]);
    const actual = createHmac("sha256", secret).update(signedPayload).digest("hex");
    if (!v1s.some((v1) => hexEquals(actual, v1))) {
      return { ok: false, reason: "signature-invalid" };
    }
    const tolerance = toleranceMs ?? STRIPE_V1_DEFAULT_TOLERANCE_MS;
    if (Math.abs(nowMs - timestamp * 1000) > tolerance) {
      return { ok: false, reason: "stale" };
    }
    return { ok: true };
  },
};

registerSignatureVerifier("hmac-sha256", hmacSha256);
registerSignatureVerifier("stripe-v1", stripeV1);
