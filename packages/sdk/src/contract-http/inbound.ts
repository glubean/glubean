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
 * One delivery as received — RAW. `bodyBytes` is the exact byte sequence the
 * counterparty sent: Stripe-style HMAC signatures are computed over raw
 * bytes, so any parsing or decoding before verification would destroy the
 * evidence (design §9.1, blind spot 3).
 */
export interface InboundDelivery {
  /** Receiver-assigned, unique per delivery (claim key). */
  id: string;
  /** EXACT body bytes as received — THE signature input. */
  bodyBytes: Uint8Array;
  /**
   * UTF-8 decoded view of `bodyBytes`, for JSON parsing and display.
   * LOSSY for payloads that are not valid UTF-8 (invalid sequences become
   * replacement characters) — never feed this to a signature verifier
   * (codex I1-R2 P2).
   */
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
 * multi-source channels must be split into per-domain handles — see
 * {@link LocalInbox.scope}.
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
 * A local inbox that can derive path-scoped sub-handles. ONE underlying
 * server: `scope()` is how multiple endpoint/secret domains share one port
 * (e.g. behind a single tunnel) without an `EADDRINUSE` collision
 * (codex I1-R2 P2; design §9.4).
 */
export interface LocalInbox extends ReceiverHandle {
  /**
   * Derive a {@link ReceiverHandle} that sees only deliveries whose pathname
   * matches `path` exactly. Claims are shared with the root (ids are
   * root-global); `close()` on ANY handle closes the one underlying server —
   * one server, one lifecycle.
   */
  scope(path: string): ReceiverHandle;
}

/**
 * Zero-dependency local inbox: an ephemeral HTTP server recording every
 * request as an {@link InboundDelivery}. This is the dev/CI receiver for
 * counterparties that can reach the test host directly; tunnel transports
 * (smee.io etc.) are user-side compositions — start the tunnel pointing at
 * `inbox.url` and hand the same handle (or a `scope()` of it) to the
 * workflow.
 */
export async function createLocalInbox(options?: {
  /** Port to listen on (default 0 = ephemeral). */
  port?: number;
  /** Host to bind (default 127.0.0.1 — loopback only; wildcard binding
   * would expose the receiver on external interfaces and trips
   * loopback-only sandbox policies — codex I1-R1 P2). */
  host?: string;
}): Promise<LocalInbox> {
  const unclaimed: InboundDelivery[] = [];
  const claimed = new Set<string>();
  let seq = 0;

  const server: Server = createServer((req, res) => {
    // Collect raw Buffer chunks and concatenate ONCE: per-chunk string
    // coercion would decode each chunk separately, corrupting multi-byte
    // UTF-8 sequences split across TCP chunks — and the body is the HMAC
    // input (codex I1-R1 P2).
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => {
      const bodyBytes = Buffer.concat(chunks);
      const url = new URL(req.url ?? "/", "http://localhost");
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers[k] = v;
        else if (Array.isArray(v)) headers[k] = v.join(", ");
      }
      seq += 1;
      unclaimed.push({
        id: `d-${seq}`,
        bodyBytes: new Uint8Array(bodyBytes),
        rawBody: bodyBytes.toString("utf8"),
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

  const live = () => unclaimed.filter((d) => !claimed.has(d.id));
  const claim = (id: string) => {
    claimed.add(id);
  };
  // Idempotent: server.close() rejects with ERR_SERVER_NOT_RUNNING when
  // called twice, and scoped handles share this one server.
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }));
  const rootUrl = `http://${host}:${port}`;

  return {
    deliveries: live,
    claim,
    url: rootUrl,
    close,
    scope: (path: string) => ({
      deliveries: () => live().filter((d) => d.path === path),
      claim,
      url: `${rootUrl}${path}`,
      close,
    }),
  };
}
