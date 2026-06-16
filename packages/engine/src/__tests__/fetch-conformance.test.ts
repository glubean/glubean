import { describe, it, expect } from "vitest";

import ky from "ky";

import type { FetchImpl } from "../types.js";

// ============================================================================
// fetch-conformance (codex Decision-B P1-3): ky 2 must work over a BROWSER-style
// fetch that wraps a serialized-response transport (like lite's CORS-bypass
// extension, which returns { status, headers:[[k,v]], body }). The wrapper must
// honor the real fetch contract: accept a Request, clone-before-read the body
// (so retries can re-send), honor AbortSignal, map transport failure to a network
// error (NOT a status-0 Response ky would treat as a real response), and return a
// real Response. If ky 2 + this wrapper pass, Decision B holds for the browser.
// ============================================================================

interface SerializedResponse {
  status?: number;
  statusText?: string;
  headers?: [string, string][];
  body?: string | null;
  error?: string; // transport-level failure (e.g. extension offline)
}
type Handler = (req: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}) => SerializedResponse | Promise<SerializedResponse>;

// The browser fetch wrapper under test.
function makeExtensionFetch(handler: Handler): FetchImpl {
  return (input, init) =>
    new Promise<Response>((resolve, reject) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const signal = req.signal;
      if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
      const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
      signal?.addEventListener("abort", onAbort, { once: true });

      // Clone BEFORE reading so the original request is never consumed (retries
      // re-send the body). GET/HEAD have no body.
      const bodyPromise =
        req.method === "GET" || req.method === "HEAD" ? Promise.resolve(undefined) : req.clone().text();

      bodyPromise
        .then((body) =>
          handler({
            method: req.method,
            url: req.url,
            headers: Object.fromEntries(req.headers.entries()),
            body,
          }),
        )
        .then((s) => {
          signal?.removeEventListener("abort", onAbort);
          if (s.error) return reject(new TypeError(`network error: ${s.error}`));
          const status = s.status ?? 200;
          // Response forbids a body for 204/205/304 — pass null there.
          const noBody = status === 204 || status === 205 || status === 304;
          resolve(
            new Response(noBody ? null : (s.body ?? null), {
              status,
              statusText: s.statusText ?? "",
              headers: s.headers ?? [],
            }),
          );
        })
        .catch(reject);
    });
}

describe("fetch-conformance — ky 2 over a browser-style serialized-response fetch", () => {
  it("GET .json() parses a reconstructed Response", async () => {
    const fetchImpl = makeExtensionFetch(() => ({ status: 200, body: JSON.stringify({ ok: true, n: 7 }) }));
    const api = ky.create({ fetch: fetchImpl as typeof fetch });
    const data = (await api.get("https://api.test/thing").json()) as { ok: boolean; n: number };
    expect(data).toEqual({ ok: true, n: 7 });
  });

  it("POST json: the request body reaches the transport (clone-before-read)", async () => {
    let seenBody: string | undefined;
    const fetchImpl = makeExtensionFetch((req) => {
      seenBody = req.body;
      return { status: 200, body: req.body ?? "" };
    });
    const api = ky.create({ fetch: fetchImpl as typeof fetch });
    const echoed = (await api.post("https://api.test/echo", { json: { a: 1 } }).json()) as { a: number };
    expect(seenBody).toBe(JSON.stringify({ a: 1 }));
    expect(echoed).toEqual({ a: 1 });
  });

  it(".extend({prefix}) joins the URL (ky 2 native prefix)", async () => {
    let seenUrl = "";
    const fetchImpl = makeExtensionFetch((req) => {
      seenUrl = req.url;
      return { status: 200, body: "{}" };
    });
    const api = ky.create({ fetch: fetchImpl as typeof fetch }).extend({ prefix: "https://api.test/v1" });
    await api.get("users").json();
    expect(seenUrl).toBe("https://api.test/v1/users");
  });

  it("retry: a 500 then 200 retries and re-sends the body (clone survives retry)", async () => {
    const bodies: (string | undefined)[] = [];
    let calls = 0;
    const fetchImpl = makeExtensionFetch((req) => {
      calls += 1;
      bodies.push(req.body);
      return calls === 1 ? { status: 500, body: "err" } : { status: 200, body: JSON.stringify({ ok: true }) };
    });
    const api = ky.create({ fetch: fetchImpl as typeof fetch, retry: { limit: 2, methods: ["post"] } });
    const data = (await api.post("https://api.test/x", { json: { v: 1 } }).json()) as { ok: boolean };
    expect(calls).toBe(2);
    expect(data).toEqual({ ok: true });
    // Body re-sent on the retry (clone-before-read did not consume the original).
    expect(bodies).toEqual([JSON.stringify({ v: 1 }), JSON.stringify({ v: 1 })]);
  });

  it("204 / empty body: .json() throws (ky 2), .text() is empty", async () => {
    const fetchImpl = makeExtensionFetch(() => ({ status: 204 }));
    const api = ky.create({ fetch: fetchImpl as typeof fetch });
    await expect(api.get("https://api.test/none").json()).rejects.toBeTruthy();
    const fetchImpl2 = makeExtensionFetch(() => ({ status: 204 }));
    const api2 = ky.create({ fetch: fetchImpl2 as typeof fetch });
    expect(await api2.get("https://api.test/none").text()).toBe("");
  });

  it("response headers pass through", async () => {
    const fetchImpl = makeExtensionFetch(() => ({
      status: 200,
      body: "{}",
      headers: [["x-trace-id", "abc123"]],
    }));
    const api = ky.create({ fetch: fetchImpl as typeof fetch });
    const res = await api.get("https://api.test/h");
    expect(res.headers.get("x-trace-id")).toBe("abc123");
  });

  it("transport failure maps to a thrown network error, not a status-0 response", async () => {
    const fetchImpl = makeExtensionFetch(() => ({ error: "extension offline" }));
    const api = ky.create({ fetch: fetchImpl as typeof fetch, retry: 0 });
    await expect(api.get("https://api.test/down")).rejects.toThrow(/network error|extension offline/);
  });

  it("timeout: ky aborts via signal and the wrapper honors it (best-effort abort)", async () => {
    const fetchImpl = makeExtensionFetch(
      () => new Promise<SerializedResponse>((r) => setTimeout(() => r({ status: 200, body: "{}" }), 200)),
    );
    const api = ky.create({ fetch: fetchImpl as typeof fetch, retry: 0 });
    await expect(api.get("https://api.test/slow", { timeout: 30 }).json()).rejects.toBeTruthy();
  });
});
