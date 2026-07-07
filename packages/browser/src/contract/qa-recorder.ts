/**
 * Mode B QA recorder — the seal logic (GLU-234/235 · P1-4/P1-5, proposal §2.5).
 *
 * glubean rides on the agent's browser as a PASSIVE recorder: the observation
 * layer (network / console) is emitted by OUR code (stable), and on `stop` the
 * recorder seals a run into an `agent-qa-report/v1`. The "judgement-layer
 * bonus" (§2.5): because the observation evidence is real, the machine-checkable
 * expects (url / calls / console) are runtime-judged here with the SAME matchers
 * Mode A uses — the agent supplies only dom semantics + extraFindings.
 *
 * `provenance` stays `agent-judged` (the agent drove the browser; glubean did
 * not orchestrate it); each expect verdict additionally records whether it was
 * `runtime`- or `agent`-judged, so a downstream consumer never confuses the two
 * (母提案 §2.6 four-way failure semantics).
 *
 * This module is the PURE, testable core. The `glubean qa` CLI wires a live
 * browser recorder to it (open/attach/stop).
 */

import { matchCalls, matchConsole, matchUrl } from "./matchers.js";
import type { BrowserContractCase, BrowserEvidence, BrowserExpect } from "./types.js";

/** verdict枚举 — matches agent-qa-report-v1.md §3. */
export type QaVerdict = "pass" | "fail" | "blocked" | "unverified";

/** One answered expect in the fixed questionnaire. */
export interface QaExpectAnswer {
  id: string;
  verdict: QaVerdict;
  /** method+url+status / url / console excerpt — never a request/response body. */
  evidence?: string;
  /** Required when verdict is `unverified`. */
  reason?: string;
  /** Whether this verdict was produced by the runtime judge or the agent. */
  judgedBy: "runtime" | "agent";
}

/** One journey step's recorded outcome. */
export interface QaStep {
  id: string;
  status: "completed" | "blocked" | "skipped";
  note?: string;
  evidence?: string[];
}

/** An agent-finding/v1 (embedded form) — see agent-finding-v1.md §3. */
export interface QaExtraFinding {
  category: "functional" | "layout" | "perf" | "a11y" | "copy" | "console-noise" | "data" | "security" | "other";
  severity: "P1" | "P2" | "P3" | "P4";
  title: string;
  note: string;
  evidence?: string[];
  source?: { attention: string };
  surface?: { url?: string; repo?: string; mod?: string };
}

/** The Mode B output contract — agent-qa-report/v1. */
export interface AgentQaReport {
  kind: "agent-qa-report/v1";
  contract: string;
  case: string;
  contractRevision: string;
  executor: { kind: "agent"; model: string; round?: number; startedAt?: string; finishedAt?: string };
  steps: QaStep[];
  expect: QaExpectAnswer[];
  extraFindings: QaExtraFinding[];
  provenance: "agent-judged";
}

/**
 * Runtime-judge the machine-checkable expects (url / calls / console) of a
 * browser case against recorded evidence. `dom` expects are NOT machine-judged
 * here — they need the live page the agent drove — so they come back
 * `unverified` (judgedBy: agent) for the agent/report to fill in.
 */
export function judgeRecordedExpects(
  caseSpec: BrowserContractCase,
  evidence: BrowserEvidence,
): QaExpectAnswer[] {
  const answers: QaExpectAnswer[] = [];
  for (const raw of caseSpec.expect ?? []) {
    const e = raw as {
      id: string;
      url?: Extract<BrowserExpect, { url: unknown }>["url"];
      dom?: Extract<BrowserExpect, { dom: unknown }>["dom"];
      calls?: Extract<BrowserExpect, { calls: unknown }>["calls"];
      console?: Extract<BrowserExpect, { console: unknown }>["console"];
    };
    if (e.url) {
      const r = matchUrl(e.url, evidence.finalUrl);
      answers.push({ id: e.id, verdict: r.ok ? "pass" : "fail", evidence: r.detail, judgedBy: "runtime" });
    } else if (e.calls) {
      const r = matchCalls(e.calls, evidence.network);
      answers.push(
        r.matched && r.schema === "unverified"
          ? { id: e.id, verdict: "unverified", reason: r.detail, evidence: r.detail, judgedBy: "runtime" }
          : { id: e.id, verdict: r.matched ? "pass" : "fail", evidence: r.detail, judgedBy: "runtime" },
      );
    } else if (e.console) {
      const r = matchConsole(e.console, evidence.consoleErrors);
      answers.push({ id: e.id, verdict: r.ok ? "pass" : "fail", evidence: r.detail, judgedBy: "runtime" });
    } else if (e.dom) {
      // DOM semantics need the live page — left for the agent to answer.
      answers.push({
        id: e.id,
        verdict: "unverified",
        reason: "dom expect needs the live page — answer supplied by the agent, not the passive recorder",
        judgedBy: "agent",
      });
    } else {
      answers.push({ id: e.id, verdict: "unverified", reason: "unknown expect kind", judgedBy: "agent" });
    }
  }
  return answers;
}

/** Inputs to seal a recorded QA run into an agent-qa-report/v1. */
export interface SealQaRunInput {
  contractId: string;
  caseKey: string;
  caseSpec: BrowserContractCase;
  contractRevision: string;
  evidence: BrowserEvidence;
  executor: AgentQaReport["executor"];
  steps?: QaStep[];
  /** Agent-supplied answers (e.g. dom) that override the recorder's `unverified`. */
  agentAnswers?: QaExpectAnswer[];
  extraFindings?: QaExtraFinding[];
}

/**
 * Seal a recorded run: runtime-judge the machine-checkable expects, merge any
 * agent-supplied answers (by id — agent wins for dom / anything it answered),
 * and produce the `agent-qa-report/v1`. Always `provenance: agent-judged`.
 */
export function sealQaReport(input: SealQaRunInput): AgentQaReport {
  const runtime = judgeRecordedExpects(input.caseSpec, input.evidence);
  const byId = new Map<string, QaExpectAnswer>(runtime.map((a) => [a.id, a]));
  for (const a of input.agentAnswers ?? []) {
    // Agent answers may ONLY fill in what the runtime judge left to the agent
    // (dom / anything `judgedBy: "agent"`). A runtime-judged machine-checkable
    // verdict (url / calls / console) is authoritative — an agent answer must
    // never flip a failed expect.calls / url / console into a pass.
    const existing = byId.get(a.id);
    if (existing && existing.judgedBy === "runtime") continue;
    byId.set(a.id, { ...a, judgedBy: "agent" });
  }
  // Preserve spec order.
  const expect = (input.caseSpec.expect ?? []).map(
    (e) => byId.get((e as { id: string }).id) ?? { id: (e as { id: string }).id, verdict: "blocked" as const, judgedBy: "agent" as const },
  );

  return {
    kind: "agent-qa-report/v1",
    contract: input.contractId,
    case: input.caseKey,
    contractRevision: input.contractRevision,
    executor: input.executor,
    steps: input.steps ?? [],
    expect,
    extraFindings: input.extraFindings ?? [],
    provenance: "agent-judged",
  };
}
