// Serve the engine smoke in a REAL browser — the deeper half of the guardrail.
// (Re)builds the bundle from the current engine/sdk dist (build-gate runs first;
// a node leak throws and the server never starts), then serves the page plus a
// same-origin echo API so in-browser ky 2 hits a real network endpoint with NO
// CORS. Point chrome-devtools at the printed URL, wait for window.__GLUBEAN_SMOKE.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildSmoke } from "./build-smoke.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.SMOKE_PORT || 8930);

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>engine browser smoke</title></head>
<body><pre id="out">running…</pre>
<script type="module" src="/smoke.bundle.js"></script>
<script>
  const tick = setInterval(() => {
    if (globalThis.__GLUBEAN_SMOKE && globalThis.__GLUBEAN_SMOKE.done) {
      clearInterval(tick);
      document.getElementById("out").textContent = JSON.stringify(globalThis.__GLUBEAN_SMOKE, null, 2);
    }
  }, 50);
</script></body></html>`;

function readReqBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
  });
}

await buildSmoke(); // build-gate first; a node leak throws here → no server

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
    return;
  }
  if (url.pathname === "/favicon.ico") {
    // 204 (not 404) so the console stays truly clean — a real error during a
    // migration step then stands out unambiguously.
    res.writeHead(204);
    res.end();
    return;
  }
  if (url.pathname === "/smoke.bundle.js") {
    const js = await readFile(join(HERE, "dist-smoke", "smoke.bundle.js"));
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    res.end(js);
    return;
  }
  if (url.pathname === "/api/echo") {
    const raw = await readReqBody(req);
    let body = raw || null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      /* keep raw string */
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body,
      }),
    );
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, () => {
  console.log(`engine smoke serving on http://localhost:${PORT}  (Ctrl-C to stop)`);
});
