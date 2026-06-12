/**
 * I1 — receiver protocol + local inbox (inbound-contract-design §9.1).
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createLocalInbox } from "./inbound.js";

const post = async (
  url: string,
  body: string | Uint8Array,
  headers: Record<string, string> = {},
) => fetch(url, { method: "POST", body, headers });

describe("createLocalInbox (I1)", () => {
  it("records deliveries RAW: exact body bytes, lowercased headers, method/path/receivedAt", async () => {
    const inbox = await createLocalInbox();
    try {
      const raw = '{"type":"payment_intent.created","data":{"object":{"id":"pi_1"}}}';
      const before = Date.now();
      await post(inbox.url, raw, { "Stripe-Signature": "t=1,v1=abc", "content-type": "application/json" });
      const [d] = inbox.deliveries();
      expect(d.rawBody).toBe(raw); // decoded view matches for valid UTF-8
      expect(Buffer.from(d.bodyBytes).toString("utf8")).toBe(raw);
      expect(d.headers["stripe-signature"]).toBe("t=1,v1=abc");
      expect(d.method).toBe("POST");
      expect(d.path).toBe("/");
      expect(d.receivedAt).toBeGreaterThanOrEqual(before);
      expect(d.id).toBeTruthy();
    } finally {
      await inbox.close();
    }
  });

  it("multi-byte UTF-8 bodies survive chunked transfer intact (HMAC fidelity, codex R1)", async () => {
    const inbox = await createLocalInbox();
    try {
      const raw = JSON.stringify({ note: "支付完成 ✓ — naïve café", emoji: "🎉".repeat(2000) });
      await post(inbox.url, raw, { "content-type": "application/json" });
      expect(inbox.deliveries()[0].rawBody).toBe(raw); // byte-faithful through chunking
    } finally {
      await inbox.close();
    }
  });

  it("bodyBytes preserves non-UTF-8 payloads exactly — the HMAC input (codex R2)", async () => {
    const inbox = await createLocalInbox();
    try {
      // 0xFF/0xFE are invalid UTF-8 — toString("utf8") replaces them.
      const sent = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0xff, 0xfe, 0x01]);
      await post(inbox.url, sent, { "content-type": "application/octet-stream" });
      const [d] = inbox.deliveries();
      expect(Buffer.compare(Buffer.from(d.bodyBytes), sent)).toBe(0);
      // The decoded view is lossy here — re-encoding it must NOT be used for HMAC:
      expect(Buffer.compare(Buffer.from(d.rawBody, "utf8"), sent)).not.toBe(0);
      // A verifier hashing bodyBytes reproduces the sender's signature:
      const sig = (bytes: Uint8Array) => createHmac("sha256", "whsec_x").update(bytes).digest("hex");
      expect(sig(d.bodyBytes)).toBe(sig(sent));
    } finally {
      await inbox.close();
    }
  });

  it("claim is NON-DESTRUCTIVE for others: only the claimed delivery disappears", async () => {
    const inbox = await createLocalInbox();
    try {
      await post(inbox.url, "first");
      await post(inbox.url, "second");
      await post(inbox.url, "third");
      const all = inbox.deliveries();
      expect(all.map((d) => d.rawBody)).toEqual(["first", "second", "third"]);
      inbox.claim(all[1].id); // claim the middle one
      expect(inbox.deliveries().map((d) => d.rawBody)).toEqual(["first", "third"]);
      inbox.claim("unknown-id"); // idempotent no-op
      expect(inbox.deliveries()).toHaveLength(2);
    } finally {
      await inbox.close();
    }
  });

  it("scope(): one server, per-path domains — shared port without EADDRINUSE (codex R2)", async () => {
    const inbox = await createLocalInbox();
    const stripe = inbox.scope("/stripe");
    const github = inbox.scope("/github");
    try {
      expect(stripe.url).toBe(`${inbox.url}/stripe`);
      await post(stripe.url, "stripe-evt");
      await post(github.url, "github-evt");
      expect(stripe.deliveries().map((d) => d.rawBody)).toEqual(["stripe-evt"]);
      expect(github.deliveries().map((d) => d.rawBody)).toEqual(["github-evt"]);
      // Claims are root-global: claiming in one scope removes it everywhere.
      stripe.claim(stripe.deliveries()[0].id);
      expect(stripe.deliveries()).toHaveLength(0);
      expect(inbox.deliveries().map((d) => d.rawBody)).toEqual(["github-evt"]);
    } finally {
      await inbox.close();
      await stripe.close(); // idempotent — one server, one lifecycle
    }
  });
});
