/**
 * I3 — workflow inbound poll (inbound-contract-design §9.3/§9.4a):
 * builder validation, projection, and the full await loop over a receiver.
 */

import { createHmac } from "node:crypto";
import { describe, expect, it, beforeEach } from "vitest";
import { contract, inboundCase, workflow } from "@glubean/sdk";
import { runWorkflow } from "./execute.js";
import type { InboundDelivery, ReceiverHandle, TestContext, Trace } from "@glubean/sdk";
import { clearRegistry, clearBootstrapRegistry } from "@glubean/sdk/internal";

beforeEach(() => {
  clearRegistry();
  clearBootstrapRegistry();
});

// --- doubles -----------------------------------------------------------------

const enc = new TextEncoder();
let seq = 0;

const makeDelivery = (
  body: string,
  headers: Record<string, string> = {},
  receivedAt = Date.now(),
): InboundDelivery => ({
  id: `d-${++seq}`,
  bodyBytes: enc.encode(body),
  rawBody: body,
  headers,
  method: "POST",
  path: "/",
  receivedAt,
});

/** In-memory ReceiverHandle (protocol shape only — no sockets in unit tests). */
function fakeInbox(initial: InboundDelivery[] = []): ReceiverHandle & {
  push(d: InboundDelivery): void;
  claimedIds(): string[];
} {
  const all = [...initial];
  const claimed = new Set<string>();
  return {
    deliveries: () => all.filter((d) => !claimed.has(d.id)),
    claim: (id) => {
      claimed.add(id);
    },
    url: "http://127.0.0.1:0",
    close: async () => {},
    push: (d) => {
      all.push(d);
    },
    claimedIds: () => [...claimed],
  };
}

interface Recorded {
  events: Array<{ type: string; data: Record<string, unknown> }>;
}

function baseCtx(secretMap: Record<string, string> = {}): { ctx: TestContext; rec: Recorded } {
  const rec: Recorded = { events: [] };
  const ctx = {
    assert: () => {},
    validate: (d: unknown) => d,
    trace: (_t: Trace) => {},
    metric: () => {},
    event: (ev: { type: string; data?: Record<string, unknown> }) => {
      rec.events.push({ type: ev.type, data: ev.data ?? {} });
    },
    log: () => {},
    warn: () => {},
    action: () => {},
    skip: (reason?: string): never => {
      const e = new Error(reason ?? "skipped");
      e.name = "SkipError";
      throw e;
    },
    secrets: {
      require: (name: string) => {
        const v = secretMap[name];
        if (v === undefined) throw new Error(`Secret "${name}" is not set`);
        return v;
      },
      get: (name: string) => secretMap[name],
    },
  } as unknown as TestContext;
  return { ctx, rec };
}

/** Discriminating schema: accepts only `type: "created"` events. */
const createdSchema = {
  safeParse: (d: unknown) => {
    const ok = !!d && typeof d === "object" && (d as { type?: unknown }).type === "created";
    return ok
      ? { success: true as const, data: d }
      : { success: false as const, error: { issues: [{ message: "wrong type" }] } };
  },
};

const makeContract = (within?: number, signature?: boolean) =>
  contract.http.with("api", {})("stripe.webhooks", {
    endpoint: "POST /webhooks/stripe",
    cases: {
      created: inboundCase({
        description: "counterparty posts the created event",
        expect: {
          bodySchema: createdSchema,
          ...(signature
            ? { signature: { scheme: "hmac-sha256" as const, header: "x-sig", secretRef: "WH_SECRET" } }
            : {}),
          ...(within !== undefined ? { within } : {}),
        },
      }),
    },
  });

const attemptsOf = (rec: Recorded) =>
  rec.events
    .filter((e) => e.type === "workflow:poll_attempt")
    .map((e) => e.data as { outcome: string; classification?: string; withinDeltaMs?: number });

// --- builder validation --------------------------------------------------------

describe("builder — inbound poll declaration", () => {
  const ref = () => makeContract(60_000).case("created");

  it("rejects outbound-only vocabulary with the reason", () => {
    for (const [key, value] of [
      ["until", (w: { ok: { eq: unknown } }) => w], // shape irrelevant — presence is rejected
      ["untilRuntime", () => true],
      ["in", () => ({})],
      ["accept", [200]],
      ["message", "m"],
    ] as const) {
      expect(() =>
        workflow("w").poll("wait", ref() as never, {
          via: (s: { inbox: unknown }) => s.inbox,
          [key]: value,
        } as never),
      ).toThrow(new RegExp(`\`${key}\` is not allowed on an inbound poll`));
    }
  });

  it("requires via; correlate requires BOTH lenses", () => {
    expect(() => workflow("w").poll("wait", ref() as never, {} as never)).toThrow(
      /`via` is required/,
    );
    expect(() =>
      workflow("w").poll("wait", ref() as never, {
        via: (s: { inbox: unknown }) => s.inbox,
        correlate: { event: (e: { id: string }) => e.id },
      } as never),
    ).toThrow(/needs BOTH lenses/);
  });

  it("timeout defaults from expect.within; absent both → bounds error", () => {
    const wf = workflow("w")
      .poll("wait", makeContract(45_000).case("created") as never, {
        via: (s: { inbox: unknown }) => s.inbox,
      } as never)
      .build();
    const node = wf._projection.nodes[0];
    expect(node.timeoutMs).toBe(45_000);
    expect(node.inbound?.withinMs).toBe(45_000);

    expect(() =>
      workflow("w2").poll("wait", makeContract(undefined).case("created") as never, {
        via: (s: { inbox: unknown }) => s.inbox,
      } as never),
    ).toThrow(/needs a stop condition/);
  });

  it("outbound poll rejects the inbound-only via/correlate options", () => {
    const outbound = contract.http.with("api", {})("orders", {
      endpoint: "GET /orders/:id",
      cases: { ok: { description: "ok", expect: { status: 200 } } },
    });
    expect(() =>
      workflow("w").poll("wait", outbound.case("ok"), {
        via: (s: { inbox: unknown }) => s.inbox,
        until: (w: { status: { eq: (v: number) => unknown } }) => w.status.eq(200),
        timeout: 1000,
      } as never),
    ).toThrow(/`via`\/`correlate` are inbound-poll options/);
  });

  it("projects kind:poll + inbound{viaPath, correlate paths, withinMs}, grade full, NO until", () => {
    const wf = workflow("w")
      .poll("wait", makeContract(30_000).case("created") as never, {
        via: (s: { inbox: unknown }) => s.inbox,
        correlate: {
          event: (e: { data: { id: string } }) => e.data.id,
          state: (s: { piId: string }) => s.piId,
        },
      } as never)
      .build();
    const node = wf._projection.nodes[0];
    expect(node.kind).toBe("poll");
    expect(node.grade).toBe("full");
    expect(node.until).toBeUndefined();
    expect(node.inbound).toEqual({
      viaPath: ["inbox"],
      correlate: { eventPath: ["data", "id"], statePath: ["piId"] },
      withinMs: 30_000,
    });
    expect(node.contractId).toBe("stripe.webhooks");
    expect(node.caseKey).toBe("created");
    expect(wf._projection.gradeSummary.full).toBe(1);
  });
});

// --- execution -----------------------------------------------------------------

describe("execution — the await loop (§9.3/§9.4a)", () => {
  it("pre-existing delivery satisfies; out receives the PARSED body; withinDelta ≤ 0", async () => {
    const { ctx, rec } = baseCtx();
    const inbox = fakeInbox([
      makeDelivery('{"type":"created","data":{"id":"pi_1"}}', {}, Date.now() - 500),
    ]);
    const wf = workflow("w")
      .setup(async () => ({ inbox, piId: "pi_1", evt: undefined as unknown }))
      .poll("wait", makeContract(30_000).case("created") as never, {
        via: (s: { inbox: unknown }) => s.inbox,
        correlate: {
          event: (e: { data: { id: string } }) => e.data.id,
          state: (s: { piId: string }) => s.piId,
        },
        out: (s: object, evt: unknown) => ({ ...s, evt }),
      } as never)
      .build();

    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("passed");
    expect((res.state as { evt: unknown }).evt).toEqual({
      type: "created",
      data: { id: "pi_1" },
    });
    expect(inbox.claimedIds()).toHaveLength(1);
    const [attempt] = attemptsOf(rec);
    expect(attempt.outcome).toBe("satisfied");
    expect(attempt.classification).toBe("matched");
    expect(attempt.withinDeltaMs).toBeLessThanOrEqual(0); // early arrival is allowed evidence (§9.4a #3)
  });

  it("walks the snapshot in order: sibling-run noise stays unclaimed, ours is claimed", async () => {
    const { ctx, rec } = baseCtx();
    const sibling = makeDelivery('{"type":"created","data":{"id":"pi_OTHER"}}');
    const ours = makeDelivery('{"type":"created","data":{"id":"pi_1"}}');
    const inbox = fakeInbox([sibling, ours]);
    const wf = workflow("w")
      .setup(async () => ({ inbox, piId: "pi_1" }))
      .poll("wait", makeContract(30_000).case("created") as never, {
        via: (s: { inbox: unknown }) => s.inbox,
        correlate: {
          event: (e: { data: { id: string } }) => e.data.id,
          state: (s: { piId: string }) => s.piId,
        },
      } as never)
      .build();

    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("passed");
    // Non-destructive (§9.1): only OUR delivery was claimed.
    expect(inbox.claimedIds()).toEqual([ours.id]);
    expect(inbox.deliveries().map((d) => d.id)).toEqual([sibling.id]);
    expect(attemptsOf(rec)[0].classification).toBe("matched");
  });

  it("probe attempts carry attribution; a later delivery satisfies a later attempt", async () => {
    const { ctx, rec } = baseCtx();
    const inbox = fakeInbox([makeDelivery('{"type":"succeeded"}')]); // wrong type, no correlate
    const wf = workflow("w")
      .setup(async () => ({ inbox }))
      .poll("wait", makeContract(30_000).case("created") as never, {
        via: (s: { inbox: unknown }) => s.inbox,
        timeout: 5_000,
        every: 10,
      } as never)
      .build();

    setTimeout(() => inbox.push(makeDelivery('{"type":"created"}')), 30);
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("passed");
    const attempts = attemptsOf(rec);
    expect(attempts[0].outcome).toBe("probe");
    expect(attempts[0].classification).toBe("type-mismatch");
    expect(attempts.at(-1)!.outcome).toBe("satisfied");
    // The wrong-type delivery is still there for other consumers.
    expect(inbox.deliveries()).toHaveLength(1);
  });

  it("with correlate: an unrelated shape (no `data` at all) is a probe, never a node fail (codex R1)", async () => {
    const { ctx, rec } = baseCtx();
    // A direct `e => e.data.id` lens would throw here; the path walk must classify.
    const inbox = fakeInbox([makeDelivery('{"ping":true}')]);
    const wf = workflow("w")
      .setup(async () => ({ inbox, piId: "pi_1" }))
      .poll("wait", makeContract(30_000).case("created") as never, {
        via: (s: { inbox: unknown }) => s.inbox,
        correlate: {
          event: (e: { data: { id: string } }) => e.data.id,
          state: (s: { piId: string }) => s.piId,
        },
        timeout: 5_000,
        every: 10,
      } as never)
      .build();
    setTimeout(() => inbox.push(makeDelivery('{"type":"created","data":{"id":"pi_1"}}')), 30);
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("passed");
    expect(attemptsOf(rec)[0]).toMatchObject({ outcome: "probe", classification: "type-mismatch" });
  });

  it("correlate.state resolving undefined fails fast with a named error (missing-operand rule)", async () => {
    const { ctx } = baseCtx();
    const inbox = fakeInbox([makeDelivery('{"type":"created","data":{"id":"pi_1"}}')]);
    const wf = workflow("w")
      .setup(async () => ({ inbox })) // piId NOT in state
      .poll("wait", makeContract(30_000).case("created") as never, {
        via: (s: { inbox: unknown }) => s.inbox,
        correlate: {
          event: (e: { data: { id: string } }) => e.data.id,
          state: (s: { piId?: string }) => s.piId,
        },
      } as never)
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("failed");
    expect(inbox.claimedIds()).toHaveLength(0); // undefined === undefined never matched anything
  });

  it("a forged delivery FAILS the node (first terminal wins) — nothing is claimed", async () => {
    const { ctx, rec } = baseCtx({ WH_SECRET: "whsec_test" });
    const body = '{"type":"created"}';
    const forged = makeDelivery(body, { "x-sig": "0".repeat(64) });
    const genuine = makeDelivery(body, {
      "x-sig": createHmac("sha256", "whsec_test").update(body).digest("hex"),
    });
    const inbox = fakeInbox([forged, genuine]); // forged is OLDER → first terminal
    const wf = workflow("w")
      .setup(async () => ({ inbox }))
      .poll("wait", makeContract(30_000, true).case("created") as never, {
        via: (s: { inbox: unknown }) => s.inbox,
      } as never)
      .build();

    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("failed");
    expect(inbox.claimedIds()).toHaveLength(0);
    const failed = attemptsOf(rec).find((a) => a.outcome === "failed");
    expect(failed?.classification).toBe("signature-invalid");
  });

  it("a genuinely signed delivery matches", async () => {
    const { ctx } = baseCtx({ WH_SECRET: "whsec_test" });
    const body = '{"type":"created"}';
    const inbox = fakeInbox([
      makeDelivery(body, {
        "x-sig": createHmac("sha256", "whsec_test").update(body).digest("hex"),
      }),
    ]);
    const wf = workflow("w")
      .setup(async () => ({ inbox }))
      .poll("wait", makeContract(30_000, true).case("created") as never, {
        via: (s: { inbox: unknown }) => s.inbox,
      } as never)
      .build();
    expect((await runWorkflow(wf, ctx)).status).toBe("passed");
  });

  it("unknown scheme is a hard error, not exhaustion-by-probes (§9.4 preflight)", async () => {
    const { ctx } = baseCtx();
    const c = contract.http.with("api", {})("hooks", {
      endpoint: "POST /hooks",
      cases: {
        evt: inboundCase({
          description: "d",
          expect: {
            bodySchema: createdSchema,
            signature: { scheme: "not-registered", header: "x-sig", secretRef: "WH_SECRET" },
            within: 30_000,
          },
        }),
      },
    });
    const inbox = fakeInbox([makeDelivery('{"type":"created"}', { "x-sig": "aa" })]);
    const wf = workflow("w")
      .setup(async () => ({ inbox }))
      .poll("wait", c.case("evt") as never, {
        via: (s: { inbox: unknown }) => s.inbox,
      } as never)
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("failed");
    expect(String((res.nodes[0] as { status: string }).status)).toBe("failed");
  });

  it("bad config + EMPTY inbox fails fast via preflight, not exhaustion (codex R3)", async () => {
    const { ctx, rec } = baseCtx();
    const c = contract.http.with("api", {})("hooks2", {
      endpoint: "POST /hooks",
      cases: {
        evt: inboundCase({
          description: "d",
          expect: {
            bodySchema: createdSchema,
            signature: { scheme: "never-registered", header: "x-sig", secretRef: "WH_SECRET" },
            within: 60_000, // far beyond the test runtime — only preflight can fail this fast
          },
        }),
      },
    });
    const wf = workflow("w")
      .setup(async () => ({ inbox: fakeInbox() })) // NO deliveries at all
      .poll("wait", c.case("evt") as never, {
        via: (s: { inbox: unknown }) => s.inbox,
      } as never)
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("failed");
    // First attempt failed outright — no probe ever happened.
    expect(attemptsOf(rec)[0]?.outcome).toBe("failed");
  });

  it("TYPE: an inbound ref with outbound-shaped opts is a compile error (codex R3)", () => {
    const ref = makeContract(30_000).case("created");
    void (() =>
      // @ts-expect-error — until/timeout must not fall through to the outbound overload
      workflow("w").poll("wait", ref, { until: (w: never) => w, timeout: 1000 }));
    // And the inbound overload accepts the inbound vocabulary without casts.
    void (() =>
      workflow("w")
        .setup(async () => ({ inbox: {} as unknown }))
        .poll("wait", ref, { via: (s) => s.inbox }));
    expect(true).toBe(true);
  });

  it("an empty inbox exhausts the bounds → node fails with no-delivery probes", async () => {
    const { ctx, rec } = baseCtx();
    const inbox = fakeInbox();
    const wf = workflow("w")
      .setup(async () => ({ inbox }))
      .poll("wait", makeContract(30_000).case("created") as never, {
        via: (s: { inbox: unknown }) => s.inbox,
        timeout: 60,
        every: 10,
      } as never)
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("failed");
    const attempts = attemptsOf(rec);
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts[0]).toMatchObject({ outcome: "probe", classification: "no-delivery" });
  });

  it("via not resolving to a ReceiverHandle is a clear authoring error", async () => {
    const { ctx } = baseCtx();
    const wf = workflow("w")
      .setup(async () => ({ inbox: "not-a-handle" }))
      .poll("wait", makeContract(30_000).case("created") as never, {
        via: (s: { inbox: unknown }) => s.inbox,
      } as never)
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("failed");
  });
});
