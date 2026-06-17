// Build-gate — the cheap, every-step half of the engine browser guardrail.
// Bundles the smoke entry for the browser with esbuild and FAILS LOUDLY if a
// node-only module leaks into the shared @glubean/engine core. The worry it
// kills: migrating harness features into the engine and accidentally dragging
// node-only code along, only to have to strip it out later.
//
// Leak detection: every `node:*` specifier pulled into the bundle is recorded.
// Builtins on ALLOWLIST are routed to the same browser shims lite ships — they
// load but THROW if actually CALLED on the browser path (the real-Chrome run
// catches that). A node: builtin NOT on the allowlist fails the build at once.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(HERE, "..");
const SDK = join(ENGINE, "..", "sdk");

// node builtins tolerated ONLY when imported by a dependency (SDK / ky / etc.),
// never by the engine itself: async_hooks — SDK ALS carrier constructed at import
// (runtime uses the injected globalThis carrier instead); fs/path/url/http/crypto
// — pulled by SDK data/contract code paths that are never reached on the browser
// run path. The engine core must import ZERO node builtins (it is host-agnostic:
// HTTP via injected fetch, isolation via injected carrier, crypto via Web Crypto),
// so ANY node: import whose importer is engine-side is a leak even if listed here.
const ALLOWLIST = new Set(["async_hooks", "fs", "fs/promises", "path", "url", "http", "crypto"]);

// An importer that is the engine's own code (its dist, or this smoke harness) —
// as opposed to a third-party/workspace dependency under another package.
const isEngineImporter = (importer) => importer.replaceAll("\\", "/").includes("/packages/engine/");

export async function buildSmoke({ write = true } = {}) {
  const pulled = new Set();
  const offenders = new Set();

  const nodeBuiltinGate = {
    name: "node-builtin-gate",
    setup(b) {
      b.onResolve({ filter: /^node:/ }, (args) => {
        const name = args.path.slice("node:".length);
        pulled.add(name);
        // Leak if the ENGINE itself imports any node builtin (even an allowlisted
        // one — the core must stay node-free), or if ANY importer pulls a builtin
        // not on the dependency allowlist.
        if (isEngineImporter(args.importer) || !ALLOWLIST.has(name)) {
          offenders.add(`${name}  (imported by ${args.importer})`);
        }
        const shim = name === "async_hooks" ? join(HERE, "shim-async-hooks.js") : join(HERE, "shim-empty.cjs");
        return { path: shim };
      });
    },
  };

  const result = await build({
    entryPoints: [join(HERE, "smoke-entry.mjs")],
    bundle: true,
    format: "esm",
    platform: "browser",
    outfile: join(HERE, "dist-smoke", "smoke.bundle.js"),
    write,
    metafile: true,
    logLevel: "silent",
    // longest matching alias wins, so @glubean/sdk/internal resolves before @glubean/sdk
    alias: {
      "@glubean/engine": join(ENGINE, "dist", "index.js"),
      "@glubean/sdk/internal": join(SDK, "dist", "internal.js"),
      "@glubean/sdk": join(SDK, "dist", "index.js"),
    },
    plugins: [nodeBuiltinGate],
  });

  const bytes = result.metafile
    ? Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0)
    : 0;

  if (offenders.size) {
    console.error("✗ LEAK: node-only builtin(s) pulled into the engine browser bundle:");
    for (const o of offenders) console.error("   - " + o);
    console.error("  Keep node-only code out of @glubean/engine (the shared core is browser-shared).");
    throw new Error(`node-builtin leak: ${[...offenders].join(", ")}`);
  }

  console.error(`✓ engine browser bundle OK — ${(bytes / 1024).toFixed(0)} KB`);
  console.error(`  node builtins pulled (all shimmed + allowlisted): ${[...pulled].sort().join(", ") || "(none)"}`);
  return { bytes, pulled: [...pulled] };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  buildSmoke().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
