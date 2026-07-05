/**
 * agent-qa-report.ts — GLU-211 scaffold: a lightweight validator + diff
 * utility for the `agent-qa-report/v1` schema (docs/agent-qa-report-v1.zh.md).
 *
 * Scope (deliberately narrow, P0 — contract-browser-two-tier.md §8 P0):
 *  - `validateAgentQaReport()` checks a report object against the schema's
 *    §5 validation rules, parameterized by a `ValidationSpec` (the step/
 *    expect ids a given `contract.browser` case declares) so it is not
 *    hardcoded to one fixture — any future `.browser.ts` contract can reuse
 *    it via `specFromBrowserContract()`.
 *  - `diffAgentQaReports()` compares two reports structurally: same step/
 *    expect id sets? which expect verdicts disagree? which extraFindings
 *    are unique to one side? This is the machinery GLU-211's hypothesis
 *    ("N independent agent rounds produce diffable reports") is checked
 *    against — see docs/mode-b-agent-qa-experiment.zh.md.
 *  - `specFromBrowserContract()` derives a `ValidationSpec` from a
 *    `.browser.ts`-shaped fixture (see auth.browser.ts) so callers never
 *    hand-copy id lists that could drift from the actual contract.
 *
 * Out of scope (GLU-211 design boundary): this module does not execute a
 * browser, does not implement the `contract.browser` runtime adapter
 * (Mode A), and never talks to Cloud or the filesystem itself. It is pure
 * validation over an already-parsed JSON report value.
 */

export const VERDICTS = ["pass", "fail", "blocked", "unverified"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const STEP_STATUSES = ["completed", "blocked", "skipped"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const FINDING_CATEGORIES = [
  "functional",
  "layout",
  "perf",
  "a11y",
  "copy",
  "console-noise",
  "data",
  "security",
  "other",
] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

/** The set of step/expect ids a contract.browser case declares — the
 * "fixed questionnaire" a report must answer in full. */
export interface ValidationSpec {
  stepIds: string[];
  expectIds: string[];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface ValidateOptions {
  /**
   * Known secret plaintext values (e.g. the staging test password). If any
   * appear verbatim anywhere in the serialized report, validation fails
   * (schema §3 red line). This module never reads env vars or disk itself —
   * callers own how secrets are loaded, so this stays testable without a
   * real filesystem/secret store.
   */
  knownSecrets?: string[];
}

interface ReportStepLike {
  id?: unknown;
  status?: unknown;
  note?: unknown;
  evidence?: unknown;
}

interface ReportExpectAnswerLike {
  id?: unknown;
  verdict?: unknown;
  evidence?: unknown;
  reason?: unknown;
}

interface ReportFindingLike {
  category?: unknown;
  severity?: unknown;
  title?: unknown;
  note?: unknown;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function isOneOf<T extends string>(values: readonly T[], v: unknown): v is T {
  return typeof v === "string" && (values as readonly string[]).includes(v);
}

/**
 * Validates a parsed `agent-qa-report/v1` object against the schema's §5
 * rules. Returns every violation found (not just the first) so a failing
 * report can be fixed in one pass.
 */
export function validateAgentQaReport(
  report: unknown,
  spec: ValidationSpec,
  options: ValidateOptions = {},
): ValidationResult {
  const errors: string[] = [];

  if (typeof report !== "object" || report === null || Array.isArray(report)) {
    return { valid: false, errors: ["report must be a JSON object"] };
  }
  const r = report as Record<string, unknown>;

  if (r.kind !== "agent-qa-report/v1") errors.push("kind must be literal 'agent-qa-report/v1'");
  if (r.provenance !== "agent-judged") errors.push("provenance must be literal 'agent-judged'");
  for (const field of ["contract", "case", "contractRevision"] as const) {
    if (!isNonEmptyString(r[field])) errors.push(`${field} required (non-empty string)`);
  }
  const executor = r.executor as Record<string, unknown> | undefined;
  if (!executor || !isNonEmptyString(executor.model)) {
    errors.push("executor.model required");
  }

  // steps[] — must cover every spec step id, each with a valid status.
  const steps = Array.isArray(r.steps) ? (r.steps as ReportStepLike[]) : null;
  if (!steps) {
    errors.push("steps must be an array");
  } else {
    for (const id of spec.stepIds) {
      if (!steps.some((s) => s?.id === id)) errors.push(`missing step: ${id}`);
    }
    for (const s of steps) {
      const label = typeof s?.id === "string" ? s.id : "<unknown>";
      if (!isOneOf(STEP_STATUSES, s?.status)) {
        errors.push(`step ${label}: bad status '${String(s?.status)}'`);
        continue;
      }
      if (s.status === "blocked" && !isNonEmptyString(s.note)) {
        errors.push(`step ${label}: blocked requires note`);
      }
      // review 6 / RESULT.md (2026-07-03): "optional evidence" was
      // empirically indistinguishable from "no evidence" across 3
      // independent rounds — completed steps must prove themselves.
      if (s.status === "completed" && !(Array.isArray(s.evidence) && s.evidence.length > 0)) {
        errors.push(`step ${label}: completed requires >=1 evidence (screenshot/URL/DOM excerpt)`);
      }
    }
  }

  // expect[] — the fixed questionnaire. Missing an id is the single most
  // important failure mode this validator exists to catch.
  const expect = Array.isArray(r.expect) ? (r.expect as ReportExpectAnswerLike[]) : null;
  if (!expect) {
    errors.push("expect must be an array");
  } else {
    for (const id of spec.expectIds) {
      const e = expect.find((x) => x?.id === id);
      if (!e) {
        errors.push(`missing expect answer: ${id} (漏答 = report INVALID)`);
        continue;
      }
      if (!isOneOf(VERDICTS, e.verdict)) {
        errors.push(`expect ${id}: bad verdict '${String(e.verdict)}'`);
        continue;
      }
      if ((e.verdict === "pass" || e.verdict === "fail") && !isNonEmptyString(e.evidence)) {
        errors.push(`expect ${id}: verdict '${e.verdict}' requires non-empty evidence`);
      }
      if (e.verdict === "unverified" && !isNonEmptyString(e.reason)) {
        errors.push(`expect ${id}: unverified requires reason`);
      }
    }
  }

  // extraFindings[] — must exist (empty array is a valid "looked, found
  // nothing"; a missing field is indistinguishable from "didn't look").
  if (!Array.isArray(r.extraFindings)) {
    errors.push("extraFindings must exist (empty array is valid, missing is not)");
  } else {
    (r.extraFindings as ReportFindingLike[]).forEach((f, i) => {
      if (!isOneOf(FINDING_CATEGORIES, f?.category)) {
        errors.push(`extraFindings[${i}]: bad category '${String(f?.category)}'`);
      }
      if (!isNonEmptyString(f?.title)) errors.push(`extraFindings[${i}]: requires title`);
      if (!isNonEmptyString(f?.note)) errors.push(`extraFindings[${i}]: requires note`);
      if (!/^P[1-4]$/.test(String(f?.severity ?? ""))) {
        errors.push(`extraFindings[${i}]: bad severity '${String(f?.severity)}'`);
      }
    });
  }

  // Secret red line (schema §3): never plaintext in any field.
  if (options.knownSecrets?.length) {
    const serialized = JSON.stringify(report);
    for (const secret of options.knownSecrets) {
      if (isNonEmptyString(secret) && serialized.includes(secret)) {
        errors.push("SECRET LEAK: report contains a known secret value in plaintext");
        break;
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export interface VerdictDelta {
  id: string;
  a: Verdict | undefined;
  b: Verdict | undefined;
}

export interface FindingSummary {
  category: string;
  title: string;
}

/**
 * Structural diff between two `agent-qa-report/v1` reports — the check the
 * GLU-211 hypothesis lives or dies on: do independent agent rounds on the
 * same contract produce reports that are actually comparable?
 */
export interface ReportDiff {
  /** Both reports answered exactly the same set of expect ids. */
  sameExpectIdSet: boolean;
  /** Both reports covered exactly the same set of step ids. */
  sameStepIdSet: boolean;
  /** Per-expect-id verdict comparison, over the union of ids seen. */
  verdictDeltas: VerdictDelta[];
  /** Expect ids whose verdict differs between the two reports. */
  disagreements: string[];
  /** extraFindings present only in `a` (by category+title). */
  extraFindingsOnlyInA: FindingSummary[];
  /** extraFindings present only in `b` (by category+title). */
  extraFindingsOnlyInB: FindingSummary[];
}

export function diffAgentQaReports(a: unknown, b: unknown): ReportDiff {
  const ra = (a ?? {}) as Record<string, unknown>;
  const rb = (b ?? {}) as Record<string, unknown>;

  const stepIdsA = new Set(extractIds(ra.steps));
  const stepIdsB = new Set(extractIds(rb.steps));
  const sameStepIdSet = sameSet(stepIdsA, stepIdsB);

  const expectA = extractExpectMap(ra.expect);
  const expectB = extractExpectMap(rb.expect);
  const sameExpectIdSet = sameSet(new Set(expectA.keys()), new Set(expectB.keys()));

  const allExpectIds = new Set([...expectA.keys(), ...expectB.keys()]);
  const verdictDeltas: VerdictDelta[] = [];
  const disagreements: string[] = [];
  for (const id of allExpectIds) {
    const va = expectA.get(id);
    const vb = expectB.get(id);
    verdictDeltas.push({ id, a: va, b: vb });
    if (va !== vb) disagreements.push(id);
  }

  const findingsA = extractFindingSummaries(ra.extraFindings);
  const findingsB = extractFindingSummaries(rb.extraFindings);
  const keyOf = (f: FindingSummary) => `${f.category}::${f.title}`;
  const keysA = new Set(findingsA.map(keyOf));
  const keysB = new Set(findingsB.map(keyOf));

  return {
    sameExpectIdSet,
    sameStepIdSet,
    verdictDeltas: verdictDeltas.sort((x, y) => x.id.localeCompare(y.id)),
    disagreements: disagreements.sort(),
    extraFindingsOnlyInA: findingsA.filter((f) => !keysB.has(keyOf(f))),
    extraFindingsOnlyInB: findingsB.filter((f) => !keysA.has(keyOf(f))),
  };
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id));
}

function extractIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (item as { id?: unknown })?.id)
    .filter((id): id is string => typeof id === "string");
}

function extractExpectMap(value: unknown): Map<string, Verdict | undefined> {
  const map = new Map<string, Verdict | undefined>();
  if (!Array.isArray(value)) return map;
  for (const item of value as ReportExpectAnswerLike[]) {
    if (typeof item?.id === "string") {
      map.set(item.id, isOneOf(VERDICTS, item.verdict) ? item.verdict : undefined);
    }
  }
  return map;
}

function extractFindingSummaries(value: unknown): FindingSummary[] {
  if (!Array.isArray(value)) return [];
  return (value as ReportFindingLike[])
    .filter((f) => isNonEmptyString(f?.title))
    .map((f) => ({ category: String(f.category ?? "unknown"), title: String(f.title) }));
}

/** A `.browser.ts`-shaped contract, narrowed to the fields this module needs. */
export interface BrowserContractLike {
  cases: Record<
    string,
    {
      steps: ReadonlyArray<{ id: string }>;
      expect: ReadonlyArray<{ id: string }>;
    }
  >;
}

/** Derives a `ValidationSpec` straight from a `.browser.ts` fixture, so the
 * step/expect id list a validator checks against can never drift from the
 * contract that actually declares them. */
export function specFromBrowserContract(contract: BrowserContractLike, caseKey: string): ValidationSpec {
  const c = contract.cases[caseKey];
  if (!c) throw new Error(`specFromBrowserContract: unknown case '${caseKey}'`);
  return {
    stepIds: c.steps.map((s) => s.id),
    expectIds: c.expect.map((e) => e.id),
  };
}
