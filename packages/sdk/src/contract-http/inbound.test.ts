/**
 * I1 — receiver protocol + local inbox (inbound-contract-design §9.1).
 */
import { describe, expect, it } from "vitest";
import { createLocalInbox } from "./inbound.js";

const post = async (url: string, body: string, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", body, headers });

describe("createLocalInbox (I1)", () => {
  it("records deliveries RAW: exact body bytes, lowercased headers, method/path/receivedAt", async () => {
    const inbox = await createLocalInbox();
    try {
      const raw = '{"type":"payment_intent.created","data":{"object":{"id":"pi_1"}}}';
      const before = Date.now();
      await post(inbox.url, raw, { "Stripe-Signature": "t=1,v1=abc", "content-type": "application/json" });
      const [d] = inbox.deliveries();
      expect(d.rawBody).toBe(raw); // EXACT bytes — the signature input
      expect(d.headers["stripe-signature"]).toBe("t=1,v1=abc");
      expect(d.method).toBe("POST");
      expect(d.path).toBe("/");
      expect(d.receivedAt).toBeGreaterThanOrEqual(before);
      expect(d.id).toBeTruthy();
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

  it("path scoping: one handle = one endpoint domain (design §9.4)", async () => {
    const inbox = await createLocalInbox({ path: "/stripe" });
    try {
      expect(inbox.url.endsWith("/stripe")).toBe(true);
      await post(inbox.url, "mine");
      const other = await post(inbox.url.replace("/stripe", "/other"), "not-mine");
      expect(other.status).toBe(404); // foreign route rejected, never recorded
      expect(inbox.deliveries().map((d) => d.rawBody)).toEqual(["mine"]);
    } finally {
      await inbox.close();
    }
  });
});
