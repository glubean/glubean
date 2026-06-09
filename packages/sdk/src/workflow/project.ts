import { extractPredicate } from "../contract-flow-condition.js";
import type {
  ActionNode,
  BranchNode,
  CheckNode,
  ComputeNode,
  ContractCallNode,
  GroupNode,
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
 * - reserved kinds (inline-protocol / branch / poll) → `opaque` until their phase.
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
 * - reserved forward kinds (inline-protocol / branch / poll) → `opaque` until their phase.
 */
export function staticGradeOf(node: WorkflowNode): StaticGrade {
  switch (node.kind) {
    case "contract-call":
    case "compute":
      return "full";
    case "action": {
      const p = (node as ActionNode).project;
      return p && (p.reads?.length || p.writes?.length || p.note) ? "partial" : "opaque";
    }
    case "check": {
      const p = (node as CheckNode).project;
      return p?.asserts ? "partial" : "opaque";
    }
    case "group":
      return (node as GroupNode).nodes.reduce(
        (g: StaticGrade, c) => worst(g, staticGradeOf(c)),
        "full" as StaticGrade,
      );
    case "branch":
      // The branch node's grade reflects the projectability of its DECISION (the
      // predicate) ONLY — L2 declarative → full, L1/L0 opaque → opaque. Children are
      // graded + tallied independently, so folding them in here would double-count
      // their opacity and hide a projectable branch decision (codex S2.4a R4).
      return ((node as BranchNode).when as { kind?: unknown }).kind === "opaque"
        ? "opaque"
        : "full";
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
      };
    }
    case "compute":
      return { ...base, kind: "compute", grade };
    case "action": {
      const p = (node as ActionNode).project;
      return { ...base, kind: "action", grade, reads: p?.reads, writes: p?.writes, note: p?.note };
    }
    case "check": {
      const p = (node as CheckNode).project;
      return { ...base, kind: "check", grade, reads: p?.reads, asserts: p?.asserts };
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
        when: extractPredicate(b.when),
        message: b.message,
        then: b.then.map(projectNode),
        else: b.else ? b.else.map(projectNode) : undefined,
      };
    }
    default:
      // Reserved forward kinds (inline-protocol / branch / poll) — not emitted by
      // the v1 builder; grade conservatively until their phase lands.
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
      acc[n.grade] += 1; // the branch node itself
      if (n.then) tallyGrades(n.then, acc);
      if (n.else) tallyGrades(n.else, acc);
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
    name: wf.meta.name,
    description: wf.meta.description,
    tags: wf.meta.tags,
    skip: wf.meta.skip,
    only: wf.meta.only,
    extensions: wf.meta.extensions,
    nodes,
    gradeSummary,
  };
}
