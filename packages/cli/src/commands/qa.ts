/**
 * `glubean qa` — the Mode B QA recorder (GLU-234/235 · P1-4/P1-5, proposal §2.5).
 *
 * glubean rides on the agent's browser as a PASSIVE recorder:
 *   - `qa open   --file f --case k`  launch an instrumented browser, print its
 *                                    CDP endpoint for the agent, record until stop.
 *   - `qa attach --endpoint <ws> --file f --case k`  connect to the agent's own
 *                                    already-running browser and record.
 *   - `qa stop`                      seal the current session: runtime-judge the
 *                                    machine-checkable expects (url/calls/console)
 *                                    against the recorded evidence and write an
 *                                    agent-qa-report/v1.
 *
 * Minimal P1 recorder: `open`/`attach` run in the foreground recording a single
 * page (the one the agent drives), and seal on SIGTERM/SIGINT — `qa stop` signals
 * the session's pid. Multi-target tracking + a full detached daemon are P2.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { bootstrap } from "@glubean/runner";
import { runWithRuntime } from "@glubean/sdk/internal";
import {
  connectChrome,
  GlubeanPage,
  sealQaReport,
  type AgentQaReport,
  type BrowserContractCase,
  type BrowserEvidence,
  type BrowserTraceRecord,
  type GlubeanBrowser,
  type InstrumentedPage,
} from "@glubean/browser";

/**
 * Build a minimal runtime carrying env vars/secrets so importing a `.browser.ts`
 * (which calls `configure(...)` at module load) can resolve the client's
 * `baseUrl`/`endpoint` vars. The recorder never executes the http contract, so
 * the http client is an unused stub. Wrap the whole flow in `runWithRuntime`.
 */
function buildRuntime(): Parameters<typeof runWithRuntime>[0] {
  const vars: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  // Pass through ALL env vars (like `glubean run`'s env-file load) so a client
  // in either mode resolves — `browser({ baseUrl: "BASE_URL" })` OR
  // `browser({ endpoint: "CHROME_ENDPOINT" })`. Secret-shaped keys are also
  // exposed via ctx.secrets for action-driven refs.
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== "string") continue;
    vars[k] = v;
    if (/(TOKEN|PASSWORD|SECRET|EMAIL|KEY)$/.test(k)) secrets[k] = v;
  }
  const httpStub = new Proxy(
    {},
    {
      get() {
        throw new Error("qa recorder: the referenced http contract is not executed (record-only).");
      },
    },
  );
  return { vars, secrets, session: {}, http: httpStub as never };
}

const SESSION_FILE = ".glubean/qa/current.json";

/**
 * Resolve the agent model id for the report's `executor.model` (required for
 * provenance/diffing). Prefer `--model`, else `GLUBEAN_QA_MODEL` — never a
 * placeholder (codex R4): a report without a precise model id is unattributable.
 */
function resolveModel(flag?: string): string {
  const model = flag ?? process.env["GLUBEAN_QA_MODEL"];
  if (!model || !model.trim()) {
    throw new Error(
      "qa: the recording agent's model id is required for the report. Pass --model <id> " +
        "(e.g. --model claude-sonnet-5) or set GLUBEAN_QA_MODEL.",
    );
  }
  return model.trim();
}

interface QaSession {
  pid: number;
  wsEndpoint?: string;
  file: string;
  caseKey: string;
  reportPath: string;
  startedAt: string;
}

/** Minimal collector ctx: records network traces + console errors, no-ops the rest. */
function makeCollector() {
  const network: BrowserTraceRecord[] = [];
  const consoleErrors: { message: string; source?: string }[] = [];
  const ctx = {
    action: () => {},
    event: (ev: { type: string; data: Record<string, unknown> }) => {
      if (ev.type === "browser:console-error") {
        consoleErrors.push({ message: String(ev.data?.message ?? ""), source: ev.data?.source as string });
      } else if (ev.type === "browser:uncaught-error") {
        consoleErrors.push({ message: `[uncaught] ${String(ev.data?.message ?? "")}` });
      }
    },
    trace: (t: Record<string, unknown>) => {
      network.push({
        method: String(t.method ?? ""),
        url: String(t.url ?? ""),
        status: Number(t.status ?? 0),
        durationMs: Number(t.durationMs ?? t.duration ?? 0),
        requestBody: t.requestBody,
        responseBody: t.responseBody,
      });
    },
    metric: () => {},
    log: () => {},
    warn: () => {},
  };
  return { ctx: ctx as never, network, consoleErrors };
}

/** Dynamically load a `.browser.ts` file and find the browser ProtocolContract carrying `caseKey`. */
async function loadBrowserCase(
  file: string,
  caseKey: string,
): Promise<{ contractId: string; caseSpec: BrowserContractCase; client?: GlubeanBrowser; revision: string }> {
  const abs = resolve(file);
  await bootstrap(dirname(abs)); // installs the browser plugin via glubean.setup.ts
  const mod = (await import(pathToFileURL(abs).href)) as Record<string, unknown>;
  for (const value of Object.values(mod)) {
    const pc = value as {
      _spec?: { cases?: Record<string, unknown>; client?: GlubeanBrowser };
      _extracted?: { id?: string; protocol?: string; cases?: Array<{ key: string; schemas?: unknown }> };
    };
    if (pc?._extracted?.protocol === "browser" && pc._spec?.cases?.[caseKey]) {
      const caseSpec = pc._spec.cases[caseKey] as BrowserContractCase;
      const projCase = pc._extracted.cases?.find((c) => c.key === caseKey);
      // contractRevision = the SEMANTIC subset only (entry + agentNotes + step
      // ids/intents + expects). Action coverage (`hasActions`) is an
      // implementation detail and must NOT churn the diff sequence.
      const s = (projCase?.schemas ?? {}) as {
        entry?: unknown;
        agentNotes?: unknown;
        intents?: unknown;
        expects?: unknown;
      };
      const revision = createHash("sha256")
        .update(
          JSON.stringify({
            id: pc._extracted.id,
            case: caseKey,
            entry: s.entry ?? null,
            agentNotes: s.agentNotes ?? null,
            intents: s.intents ?? null,
            expects: s.expects ?? null,
          }),
        )
        .digest("hex")
        .slice(0, 12);
      // Mode A resolves the client case > spec — mirror that so a per-case
      // client override is honored.
      const client = caseSpec.client ?? pc._spec.client;
      return { contractId: pc._extracted.id ?? "unknown", caseSpec, client, revision };
    }
  }
  throw new Error(`qa: no browser contract in ${file} carries case "${caseKey}".`);
}

function writeSession(s: QaSession): void {
  mkdirSync(dirname(SESSION_FILE), { recursive: true });
  writeFileSync(SESSION_FILE, JSON.stringify(s, null, 2));
}

/** Record until a stop signal, then seal an agent-qa-report/v1 + clean up. */
async function record(opts: {
  contractId: string;
  caseKey: string;
  caseSpec: BrowserContractCase;
  revision: string;
  reportPath: string;
  collector: ReturnType<typeof makeCollector>;
  model: string;
  getFinalUrl: () => string;
  cleanup: () => Promise<void>;
}): Promise<void> {
  await new Promise<void>((resolveWait) => {
    let sealed = false;
    const seal = () => {
      if (sealed) return;
      sealed = true;
      const evidence: BrowserEvidence = {
        network: [...opts.collector.network],
        consoleErrors: [...opts.collector.consoleErrors],
        finalUrl: opts.getFinalUrl(),
      };
      const report: AgentQaReport = sealQaReport({
        contractId: opts.contractId,
        caseKey: opts.caseKey,
        caseSpec: opts.caseSpec,
        contractRevision: opts.revision,
        evidence,
        executor: { kind: "agent", model: opts.model, finishedAt: new Date().toISOString() },
      });
      mkdirSync(dirname(resolve(opts.reportPath)), { recursive: true });
      writeFileSync(opts.reportPath, JSON.stringify(report, null, 2));
      // eslint-disable-next-line no-console
      console.log(`\nqa: sealed report → ${opts.reportPath} (${evidence.network.length} calls recorded)`);
      void opts.cleanup().catch(() => undefined).finally(() => {
        if (existsSync(SESSION_FILE)) rmSync(SESSION_FILE, { force: true });
        resolveWait();
      });
    };
    process.once("SIGTERM", seal);
    process.once("SIGINT", seal);
  });
}

function safeUrl(page: { url(): string } | undefined): string {
  try {
    return page?.url() ?? "";
  } catch {
    return "";
  }
}

export async function qaOpenCommand(opts: { file: string; case: string; report?: string; model?: string }): Promise<void> {
  const model = resolveModel(opts.model);
  await runWithRuntime(buildRuntime(), async () => {
    const { contractId, caseSpec, client, revision } = await loadBrowserCase(opts.file, opts.case);
    if (!client) throw new Error("qa open: the contract has no browser client to launch.");
    const reportPath = opts.report ?? `.glubean/qa/${opts.case}.report.json`;
    const collector = makeCollector();
    // `open` launches the browser and creates the recorded tab — the agent
    // connects to `wsEndpoint` and drives THIS tab.
    const page = await client.newPage(collector.ctx);
    const wsEndpoint = await client.wsEndpoint();
    writeSession({ pid: process.pid, wsEndpoint, file: opts.file, caseKey: opts.case, reportPath, startedAt: new Date().toISOString() });
    // eslint-disable-next-line no-console
    console.log(`qa: recording. Drive this browser, then run \`glubean qa stop\`.\n  cdp: ${wsEndpoint}\n  case: ${contractId}#${opts.case}`);
    await record({
      contractId,
      caseKey: opts.case,
      caseSpec,
      revision,
      reportPath,
      collector,
      model,
      getFinalUrl: () => safeUrl(page),
      cleanup: () => client.close(),
    });
  });
}

export async function qaAttachCommand(opts: {
  endpoint: string;
  file: string;
  case: string;
  report?: string;
  model?: string;
}): Promise<void> {
  const model = resolveModel(opts.model);
  await runWithRuntime(buildRuntime(), async () => {
    const { contractId, caseSpec, revision } = await loadBrowserCase(opts.file, opts.case);
    const reportPath = opts.report ?? `.glubean/qa/${opts.case}.report.json`;
    const collector = makeCollector();
    // Connect to the agent's OWN running browser and instrument the SINGLE
    // journey tab it is driving — NOT every tab (background tabs would leak
    // unrelated network/console into the evidence, per codex R3) and NOT a fresh
    // blank tab (the agent's traffic would be missed). Pick the agent's active
    // journey tab: the last non-blank page, else the first page.
    const raw = await connectChrome(opts.endpoint);
    const options = { endpoint: "attached", consoleForward: true, networkTrace: true } as never;
    const rawPages = (await raw.pages()).filter(
      (p: { url(): string }) => !p.url().startsWith("devtools://"),
    );
    const journeyRaw =
      [...rawPages].reverse().find((p: { url(): string }) => {
        const u = p.url();
        return u && u !== "about:blank";
      }) ?? rawPages[0];
    if (!journeyRaw) throw new Error("qa attach: the attached browser has no page to record.");
    const page = await GlubeanPage._create(journeyRaw as never, undefined, collector.ctx, options);
    writeSession({ pid: process.pid, wsEndpoint: opts.endpoint, file: opts.file, caseKey: opts.case, reportPath, startedAt: new Date().toISOString() });
    // eslint-disable-next-line no-console
    console.log(`qa: attached + recording ${safeUrl(page) || "(blank)"} for ${contractId}#${opts.case}. Run \`glubean qa stop\` when done.`);
    await record({
      contractId,
      caseKey: opts.case,
      caseSpec,
      revision,
      reportPath,
      collector,
      model,
      getFinalUrl: () => safeUrl(page),
      cleanup: async () => {
        raw.disconnect();
      },
    });
  });
}

/** True iff `pid` is alive AND looks like our glubean qa recorder (guards PID reuse). */
function isLiveRecorder(pid: number): boolean {
  try {
    process.kill(pid, 0); // existence check — throws if no such process
  } catch {
    return false;
  }
  try {
    const cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
    return /glubean|node|qa/i.test(cmd);
  } catch {
    // ps unavailable (non-POSIX): fall back to the existence check above.
    return true;
  }
}

export function qaStopCommand(): void {
  if (!existsSync(SESSION_FILE)) {
    throw new Error("qa stop: no active session (.glubean/qa/current.json not found).");
  }
  const s = JSON.parse(readFileSync(SESSION_FILE, "utf8")) as QaSession;
  // Verify the pid still belongs to a live recorder before signaling — a stale
  // session file after a crash must NOT SIGTERM an unrelated (pid-reused) process.
  if (!isLiveRecorder(s.pid)) {
    rmSync(SESSION_FILE, { force: true });
    throw new Error(
      `qa stop: recorder pid ${s.pid} is not running (crashed / already stopped) — cleared the stale session.`,
    );
  }
  process.kill(s.pid, "SIGTERM");
  // eslint-disable-next-line no-console
  console.log(`qa: signaled recorder (pid ${s.pid}) to seal → ${s.reportPath}`);
}
