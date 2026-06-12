/**
 * Inbound HTTP — receiver protocol + a zero-dependency local inbox.
 *
 * Design: internal/40-discovery/proposals/inbound-contract-design.md §9
 * (Candidate 1 + hybrid, owner-decided 2026-06-12). An inbound contract case
 * declares the PROMISE ("the counterparty will POST shape S, signed");
 * a receiver supplies the TRANSPORT. The two are deliberately decoupled:
 * the SDK defines the interface here, libraries/user code implement it
 * (plain functions — the extend-removal rule: tools come in via imports,
 * never via a fixtures mechanism).
 */

import { createServer, type Server } from "node:http";

/**
 * One delivery as received — RAW. `rawBody` is the exact byte string the
 * counterparty sent: Stripe-style HMAC signatures are computed over raw
 * bytes, so any parsing before verification would destroy the evidence
 * (design §9.1, blind spot 3).
 */
export interface InboundDelivery {
  /** Receiver-assigned, unique per delivery (claim key). */
  id: string;
  /** EXACT body as received — the signature input. */
  rawBody: string;
  /** Header names lowercased (node:http convention). */
  headers: Record<string, string>;
  method: string;
  path: string;
  /** Epoch ms at receipt — the measured side of `within` evidence. */
  receivedAt: number;
}

/**
 * The receiver protocol an inbound `.poll(ref, { via })` consumes
 * (design §9.1). NON-DESTRUCTIVE by construction (blind spot 2): matching
 * inspects `deliveries()` snapshots and `claim()`s only the matched one —
 * other consumers' events are never swallowed by a failed match.
 *
 * ONE handle corresponds to ONE endpoint/secret domain (design §9.4):
 * authentication-first matching FAILS the node on a signature mismatch, so
 * multi-source channels must be split at the receiver layer (e.g.
 * path-routed inboxes), never share a handle.
 */
export interface ReceiverHandle {
  /** Snapshot of UNCLAIMED deliveries, oldest first. */
  deliveries(): readonly InboundDelivery[];
  /** Mark one delivery consumed (idempotent; unknown ids are a no-op). */
  claim(id: string): void;
  /** The URL the counterparty should be pointed at. */
  url: string;
  close(): Promise<void>;
}

/**
 * Zero-dependency local inbox: an ephemeral HTTP server recording every
 * request as an {@link InboundDelivery}. This is the dev/CI receiver for
 * counterparties that can reach the test host directly; tunnel transports
 * (smee.io etc.) are user-side compositions — start the tunnel pointing at
 * `inbox.url` and hand the same handle to the workflow.
 *
 * Optional `path` scopes the inbox to one route — the cheap way to give each
 * endpoint/secret domain its own handle on a shared port (design §9.4).
 */
export async function createLocalInbox(options?: {
  /** Only record requests whose pathname matches exactly (default: all). */
  path?: string;
  /** Port to listen on (default 0 = ephemeral). */
  port?: number;
  /** Host to bind (default 127.0.0.1 — loopback only; wildcard binding
   * would expose the receiver on external interfaces and trips
   * loopback-only sandbox policies — codex I1-R1 P2). */
  host?: string;
}): Promise<ReceiverHandle> {
  const unclaimed: InboundDelivery[] = [];
  const claimed = new Set<string>();
  let seq = 0;

  const server: Server = createServer((req, res) => {
    // Collect raw Buffer chunks and decode ONCE: per-chunk string coercion
    // would decode each chunk separately, corrupting multi-byte UTF-8
    // sequences split across TCP chunks — and rawBody is the HMAC input
    // (codex I1-R1 P2).
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const url = new URL(req.url ?? "/", "http://localhost");
      if (options?.path !== undefined && url.pathname !== options.path) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers[k] = v;
        else if (Array.isArray(v)) headers[k] = v.join(", ");
      }
      seq += 1;
      unclaimed.push({
        id: `d-${seq}`,
        rawBody: body,
        headers,
        method: req.method ?? "GET",
        path: url.pathname,
        receivedAt: Date.now(),
      });
      res.statusCode = 200;
      res.end("ok");
    });
  });

  const host = options?.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options?.port ?? 0, host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  return {
    deliveries: () => unclaimed.filter((d) => !claimed.has(d.id)),
    claim: (id: string) => {
      claimed.add(id);
    },
    url: `http://${host}:${port}${options?.path ?? ""}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
