import type {
  ActionNode,
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
  switch (node.kind) {
    case "contract-call": {
      const n = node as ContractCallNode;
      return {
        ...base,
        kind: "contract-call",
        grade: "full",
        target: n.ref.target,
        protocol: n.ref.protocol,
        contractId: n.ref.contractId,
        caseKey: n.ref.caseKey,
        accept: n.accept,
      };
    }
    case "compute":
      return { ...base, kind: "compute", grade: "full" };
    case "action": {
      const p = (node as ActionNode).project;
      const hasHint = !!(p && (p.reads?.length || p.writes?.length || p.note));
      return {
        ...base,
        kind: "action",
        grade: hasHint ? "partial" : "opaque",
        reads: p?.reads,
        writes: p?.writes,
        note: p?.note,
      };
    }
    case "check": {
      const p = (node as CheckNode).project;
      return {
        ...base,
        kind: "check",
        grade: p?.asserts ? "partial" : "opaque",
        reads: p?.reads,
        asserts: p?.asserts,
      };
    }
    case "group": {
      const children = (node as GroupNode).nodes.map(projectNode);
      const grade = children.reduce(
        (g: StaticGrade, c: ProjectedWorkflowNode) => worst(g, c.grade),
        "full" as StaticGrade,
      );
      return { ...base, kind: "group", grade, nodes: children };
    }
    default:
      // Reserved forward kinds (inline-protocol / branch / poll) — not emitted by
      // the v1 builder; grade conservatively until their phase lands.
      return { ...base, kind: node.kind, grade: "opaque" };
  }
}

/** Roll grades up into the workflow-level summary (proposal §7.2), flattening groups. */
function tallyGrades(
  nodes: ProjectedWorkflowNode[],
  acc: Record<StaticGrade, number>,
): void {
  for (const n of nodes) {
    if (n.kind === "group" && n.nodes) {
      tallyGrades(n.nodes, acc);
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
