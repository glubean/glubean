import { extractPredicate } from "../contract-flow-condition.js";
import type {
  ActionNode,
  BranchNode,
  CheckNode,
  ComputeNode,
  ContractCallNode,
  GroupNode,
  PollNode,
  ProjectedWorkflowNode,
  StaticGrade,
  Workflow,
  WorkflowNode,
  WorkflowProjection,
} from "./types.js";

/**
 * Project a built `Workflow` into the JSON-safe, GRADED view that scanner /
 * Cloud / agents consume (proposal §7). Assigns each node its STATIC floor grade
 * (`full | partial | opaque`); the runtime may later promote a statically-opaque
 * node to `trace` when it emits structured evidence — that promotion is NOT done
 * here (codex R1: evidence-emission is orthogonal to the static tier).
 *
 * v1 static grading:
 * - `contract-call` → `full`. (TODO: when lens-purity tracing is reused from the
 *   flow normalizer, downgrade to `partial` if `in`/`out` aren't pure lenses.)
 * - `compute`       → `full` (pure transform).
 * - `action`        → `partial` if any `project` hint, else `opaque`.
 * - `check`         → `partial` if a `project.asserts` hint, else `opaque`.
 * - `group`         → recurses; grade = worst child (a group is only as projectable
 *   as its least-projectable member).
 * - `branch`/`poll` → the DECISION predicate's grade (L2 declarative → `full`,
 *   opaque → `opaque`); branch children are graded/tallied independently.
 * - reserved kinds (inline-protocol) → `opaque` until their phase.
 */

const GRADE_RANK: Record<StaticGrade, number> = { full: 0, partial: 1, opaque: 2 };

function worst(a: StaticGrade, b: StaticGrade): StaticGrade {
  return GRADE_RANK[a] >= GRADE_RANK[b] ? a : b;
}

/**
 * The STATIC floor grade of one node — the single source of truth for grading,
 * shared by `projectNode` (build-time view) and the executor (which feeds it to
 * `runNode` as the floor the runtime may promote `opaque` → `trace`, §17 #10).
 *
 * - `contract-call` / `compute` → `full` (declared lens / pure transform).
 *   TODO(lens-purity): downgrade a contract-call to `partial` when its in/out are
 *   not pure lenses, once the flow normalizer's tracer is reused here.
 * - `action` → `partial` if any `project` hint (reads/writes/note), else `opaque`.
 * - `check`  → `partial` if a `project.asserts` hint, else `opaque`.
 * - `group`  → worst child (a group is only as projectable as its weakest member).
 * - `branch`/`poll` → the decision/exit predicate's grade (children independent).
 * - reserved forward kinds (inline-protocol) → `opaque` until their phase.
 */
export function staticGradeOf(node: WorkflowNode): StaticGrade {
  switch (node.kind) {
    case "contract-call":
      return "full";
    case "compute":
      // S2.18 lens-purity: dataflow (reads/writes) is auto-traced and
      // projected, but the TRANSFORM LOGIC of an arbitrary sync body is
      // inherently not declarable — "synchronous" never meant "projectable".
      // `full` is reserved for nodes whose behavioral surface is fully
      // declared (contract identity / predicate data / L2 decisions).
      // Degraded trace (reads ABSENT — the dry run threw on proxy dummy
      // values) → nothing is declared → opaque (codex S2.18 R1 P2).
      return (node as ComputeNode).reads !== undefined ? "partial" : "opaque";
    case "action": {
      const p = (node as ActionNode).project;
      return p && (p.reads?.length || p.writes?.length || p.note) ? "partial" : "opaque";
    }
    case "check": {
      const c = node as CheckNode;
      // declarative expects → assertions are DATA (phase4 §7) — full.
      if (c.expects !== undefined) return "full";
      return c.project?.asserts ? "partial" : "opaque";
    }
    case "group":
      return (node as GroupNode).nodes.reduce(
        (g: StaticGrade, c) => worst(g, staticGradeOf(c)),
        "full" as StaticGrade,
      );
    case "branch": {
      // The branch-family node's grade reflects the projectability of its
      // DECISION ONLY — children are graded + tallied independently, so folding
      // them in would double-count their opacity and hide a projectable
      // decision (codex S2.4a R4). Value mode is a fully-projectable literal
      // decision table (the `on` lens carries the same trust as a call's `in`
      // lens — the lens-purity TODO covers both). Predicate mode is `full` iff
      // EVERY case predicate is L2 declarative (an opaque whenRuntime → opaque).
      const b = node as BranchNode;
      if (b.mode === "value") return "full";
      return b.cases.some((c) => (c.when as { kind?: unknown } | undefined)?.kind === "opaque")
        ? "opaque"
        : "full";
    }
    case "poll": {
      // §6.7's ladder: contract attempt + L2 exit → full; ACTION attempt
      // (pollAction, addendum §4) caps at partial — the probe is opaque even
      // when the exit predicate is declarative; opaque exit → opaque.
      const p = node as PollNode;
      // Inbound await (design §9.3): contract ref + matcher exit + gated
      // via/correlate lens paths — everything is declared, grade full.
      if (p.inbound) return "full";
      if ((p.until as { kind?: unknown }).kind === "opaque") return "opaque";
      return p.attemptFn ? "partial" : "full";
    }
    default:
      return "opaque";
  }
}

/** Common identity/meta fields lifted from a node's `NodeMeta` into its projection. */
function metaFields(node: WorkflowNode): Pick<
  ProjectedWorkflowNode,
  "id" | "name" | "description" | "tags" | "extensions"
> {
  const m = node.meta;
  return {
    id: m.id,
    name: m.name ?? m.id,
    description: m.description,
    tags: m.tags,
    extensions: m.extensions,
  };
}

function projectNode(node: WorkflowNode): ProjectedWorkflowNode {
  const base = metaFields(node);
  const grade = staticGradeOf(node); // single grade source (shared with the executor)
  switch (node.kind) {
    case "contract-call": {
      const n = node as ContractCallNode;
      return {
        ...base,
        kind: "contract-call",
        grade,
        target: n.ref.target,
        protocol: n.ref.protocol,
        contractId: n.ref.contractId,
        caseKey: n.ref.caseKey,
        accept: n.accept,
        retry: n.retry,
        ...(n.meta.timeout !== undefined ? { nodeTimeoutMs: n.meta.timeout } : {}),
      };
    }
    case "compute": {
      const c = node as ComputeNode;
      // Build-time traced dataflow (S2.18) — the honest projectable surface.
      // Absent on a degraded trace (the node is opaque then).
      return {
        ...base,
        kind: "compute",
        grade,
        ...(c.reads !== undefined ? { reads: c.reads, writes: c.writes } : {}),
      };
    }
    case "action": {
      const a = node as ActionNode;
      const p = a.project;
      return {
        ...base,
        kind: "action",
        grade,
        reads: p?.reads,
        writes: p?.writes,
        note: p?.note,
        retry: a.retry,
        ...(a.meta.timeout !== undefined ? { nodeTimeoutMs: a.meta.timeout } : {}),
      };
    }
    case "check": {
      const c = node as CheckNode;
      const p = c.project;
      return {
        ...base,
        kind: "check",
        grade,
        reads: p?.reads,
        asserts: p?.asserts,
        ...(c.expects !== undefined
          ? {
              expects: c.expects.map((item) =>
                extractPredicate(item as Parameters<typeof extractPredicate>[0]),
              ),
            }
          : {}),
        ...(c.meta.timeout !== undefined ? { nodeTimeoutMs: c.meta.timeout } : {}),
      };
    }
    case "group": {
      const children = (node as GroupNode).nodes.map(projectNode);
      return { ...base, kind: "group", grade, nodes: children };
    }
    case "branch": {
      const b = node as BranchNode;
      return {
        ...base,
        kind: "branch",
        grade,
        mode: b.mode,
        message: b.message,
        // S2.18: value mode projects the extracted selector path of `on` —
        // the decision INPUT is declared, not just the literal table.
        ...(b.onPath !== undefined ? { onPath: [...b.onPath] } : {}),
        cases: b.cases.map((c) => ({
          ...(c.label !== undefined ? { label: c.label } : {}),
          ...(c.value !== undefined ? { value: c.value } : {}),
          ...(c.when !== undefined
            ? { when: extractPredicate(c.when as Parameters<typeof extractPredicate>[0]) }
            : {}),
          nodes: c.nodes.map(projectNode),
        })),
        // Absent default = identity pass-through; project that EXPLICITLY so
        // consumers never read absence as "unknown" (S2.18 consult). Route
        // never hits the else-branch (its default is required at build).
        ...(b.default
          ? { default: b.default.map(projectNode) }
          : { defaultBehavior: "identity" as const }),
        ...(b.terminal ? { terminal: true } : {}),
      };
    }
    case "poll": {
      const p = node as PollNode;
      return {
        ...base,
        kind: "poll",
        grade,
        // contract attempt only — a pollAction probe has no call identity;
        // its dataflow hints (reads/writes/note) project instead.
        ...(p.ref
          ? {
              target: p.ref.target,
              protocol: p.ref.protocol,
              contractId: p.ref.contractId,
              caseKey: p.ref.caseKey,
            }
          : {
              reads: p.project?.reads,
              writes: p.project?.writes,
              note: p.project?.note,
            }),
        accept: p.accept,
        // The opaque until's fn takes (ctx, res, state) — wider than the condition
        // model's (ctx, state) — but extractPredicate only reads kind/sync, so the
        // cast at this seam is sound (mirrors extractPollStep). Inbound polls have
        // no predicate — matched IS the exit (§9.4a); they project `inbound` instead.
        ...(p.until !== undefined
          ? { until: extractPredicate(p.until as Parameters<typeof extractPredicate>[0]) }
          : {}),
        ...(p.inbound
          ? {
              inbound: {
                viaPath: [...p.inbound.viaPath],
                ...(p.inbound.correlate
                  ? {
                      correlate: {
                        eventPath: [...p.inbound.correlate.eventPath],
                        statePath: [...p.inbound.correlate.statePath],
                      },
                    }
                  : {}),
                ...(p.inbound.withinMs !== undefined ? { withinMs: p.inbound.withinMs } : {}),
              },
            }
          : {}),
        message: p.message,
        every: p.every,
        backoff: p.backoff,
        timeoutMs: p.timeoutMs,
        perAttemptTimeoutMs: p.perAttemptTimeoutMs,
        maxAttempts: p.maxAttempts,
      };
    }
    default:
      // Reserved forward kinds (inline-protocol) — not emitted by the v1 builder;
      // grade conservatively until their phase lands.
      return { ...base, kind: node.kind, grade };
  }
}

/** Roll grades up into the workflow-level summary (proposal §7.2). A `group` is a
 * display-only container → flattened (children counted, container not). A `branch`
 * IS a real control-flow node (its predicate carries a grade) → counted AND its
 * then/else children recursed into, so branch children aren't dropped (codex S2.4a R3). */
function tallyGrades(
  nodes: ProjectedWorkflowNode[],
  acc: Record<StaticGrade, number>,
): void {
  for (const n of nodes) {
    if (n.kind === "group" && n.nodes) {
      tallyGrades(n.nodes, acc);
    } else if (n.kind === "branch") {
      acc[n.grade] += 1; // the branch-family node itself (its decision)
      for (const c of n.cases ?? []) tallyGrades(c.nodes, acc);
      if (n.default) tallyGrades(n.default, acc);
    } else {
      acc[n.grade] += 1;
    }
  }
}

export function projectWorkflow(wf: Workflow): WorkflowProjection {
  const nodes = wf.nodes.map(projectNode);
  const gradeSummary: Record<StaticGrade, number> = { full: 0, partial: 0, opaque: 0 };
  tallyGrades(nodes, gradeSummary);
  return {
    id: wf.meta.id,
    // Data-driven members (workflow.each/pick): grouping + concurrency are
    // part of the projection wherever it is produced — not only on the cached
    // handle (codex S2.12 R5 P2).
    ...(wf.meta.templateId ? { templateId: wf.meta.templateId } : {}),
    ...(wf.meta.groupId ? { groupId: wf.meta.groupId } : {}),
    ...(wf.meta.parallel ? { parallel: true } : {}),
    name: wf.meta.name,
    description: wf.meta.description,
    tags: wf.meta.tags,
    skip: wf.meta.skip,
    only: wf.meta.only,
    extensions: wf.meta.extensions,
    // Lifecycle visibility (phase4 §6): presence + note + timeout. Without
    // this, setup/teardown — often the most opaque code in a journey — were
    // zero information to every projection consumer.
    ...(wf.setup
      ? {
          setup: {
            ...(wf.setupNote !== undefined ? { note: wf.setupNote } : {}),
            ...(wf.setupTimeoutMs !== undefined ? { timeoutMs: wf.setupTimeoutMs } : {}),
          },
        }
      : {}),
    ...(wf.teardown
      ? {
          teardown: {
            ...(wf.teardownNote !== undefined ? { note: wf.teardownNote } : {}),
            ...(wf.teardownTimeoutMs !== undefined ? { timeoutMs: wf.teardownTimeoutMs } : {}),
          },
        }
      : {}),
    nodes,
    gradeSummary,
  };
}
