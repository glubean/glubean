/**
 * I2 — inbound signature verifier registry (inbound-contract-design §9.2/§9.4).
 *
 * The taxonomy contract under test: validity FIRST, then staleness —
 * an invalid signature is `signature-invalid` even when also expired
 * (authentication-first ordering, design §9.4).
 */

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  getSignatureVerifier,
  registerSignatureVerifier,
  STRIPE_V1_DEFAULT_TOLERANCE_MS,
} from "./inbound-verify.js";

const enc = (s: string) => new TextEncoder().encode(s);
const hmacHex = (secret: string, payload: Uint8Array | string) =>
  createHmac("sha256", secret).update(payload).digest("hex");

describe("registry", () => {
  it("built-ins are pre-registered; unknown schemes return undefined", () => {
    expect(getSignatureVerifier("stripe-v1")).toBeDefined();
    expect(getSignatureVerifier("hmac-sha256")).toBeDefined();
    expect(getSignatureVerifier("nope")).toBeUndefined();
  });

  it("re-registering a scheme overwrites (last-write-wins)", () => {
    const custom = { verify: () => ({ ok: true as const }) };
    registerSignatureVerifier("custom-x", custom);
    expect(getSignatureVerifier("custom-x")).toBe(custom);
    const custom2 = { verify: () => ({ ok: false as const, reason: "signature-invalid" as const }) };
    registerSignatureVerifier("custom-x", custom2);
    expect(getSignatureVerifier("custom-x")).toBe(custom2);
  });
});

describe("hmac-sha256", () => {
  const v = getSignatureVerifier("hmac-sha256")!;
  const body = enc('{"id":"evt_1"}');
  const secret = "whsec_test";

  it("accepts a valid hex HMAC, with or without the sha256= prefix", () => {
    const sig = hmacHex(secret, body);
    expect(v.verify({ bodyBytes: body, headerValue: sig, secret, nowMs: 0 })).toEqual({ ok: true });
    expect(v.verify({ bodyBytes: body, headerValue: `sha256=${sig}`, secret, nowMs: 0 })).toEqual({ ok: true });
  });

  it("rejects wrong secret / tampered body / garbage as signature-invalid", () => {
    const sig = hmacHex(secret, body);
    expect(v.verify({ bodyBytes: body, headerValue: sig, secret: "other", nowMs: 0 }))
      .toEqual({ ok: false, reason: "signature-invalid" });
    expect(v.verify({ bodyBytes: enc("{}"), headerValue: sig, secret, nowMs: 0 }))
      .toEqual({ ok: false, reason: "signature-invalid" });
    for (const junk of ["", "zz-not-hex", "deadbeef"]) {
      expect(v.verify({ bodyBytes: body, headerValue: junk, secret, nowMs: 0 }).ok).toBe(false);
    }
  });
});

describe("stripe-v1", () => {
  const v = getSignatureVerifier("stripe-v1")!;
  const secret = "whsec_test";
  const body = enc('{"type":"payment_intent.created"}');
  const t = 1_700_000_000; // unix seconds
  const nowMs = t * 1000; // in tolerance
  const sign = (ts: number, bytes: Uint8Array, key = secret) =>
    hmacHex(key, Buffer.concat([Buffer.from(`${ts}.`), Buffer.from(bytes)]));

  it("accepts a valid t=,v1= header inside the tolerance window", () => {
    const header = `t=${t},v1=${sign(t, body)}`;
    expect(v.verify({ bodyBytes: body, headerValue: header, secret, nowMs })).toEqual({ ok: true });
  });

  it("accepts when ANY v1 matches (secret rotation sends multiples)", () => {
    const header = `t=${t},v1=${"0".repeat(64)},v1=${sign(t, body)}`;
    expect(v.verify({ bodyBytes: body, headerValue: header, secret, nowMs })).toEqual({ ok: true });
  });

  it("classifies authenticated-but-expired as stale (default 5min window)", () => {
    const header = `t=${t},v1=${sign(t, body)}`;
    const late = nowMs + STRIPE_V1_DEFAULT_TOLERANCE_MS + 1;
    expect(v.verify({ bodyBytes: body, headerValue: header, secret, nowMs: late }))
      .toEqual({ ok: false, reason: "stale" });
    // custom tolerance respected
    expect(v.verify({ bodyBytes: body, headerValue: header, secret, nowMs: nowMs + 2000, toleranceMs: 1000 }))
      .toEqual({ ok: false, reason: "stale" });
  });

  it("authentication-first: invalid AND expired → signature-invalid, not stale", () => {
    const header = `t=${t},v1=${"0".repeat(64)}`;
    const late = nowMs + STRIPE_V1_DEFAULT_TOLERANCE_MS * 10;
    expect(v.verify({ bodyBytes: body, headerValue: header, secret, nowMs: late }))
      .toEqual({ ok: false, reason: "signature-invalid" });
  });

  it("rejects malformed headers as signature-invalid", () => {
    for (const junk of ["", "v1=abc", `t=${t}`, "t=notanumber,v1=abc", "totally-garbage"]) {
      expect(v.verify({ bodyBytes: body, headerValue: junk, secret, nowMs }))
        .toEqual({ ok: false, reason: "signature-invalid" });
    }
  });

  it("signs the EXACT bytes — non-UTF-8-safe payloads verify via bodyBytes", () => {
    const rawBytes = new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]); // not valid UTF-8
    const header = `t=${t},v1=${sign(t, rawBytes)}`;
    expect(v.verify({ bodyBytes: rawBytes, headerValue: header, secret, nowMs })).toEqual({ ok: true });
  });
});
