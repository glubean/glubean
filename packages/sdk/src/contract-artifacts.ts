/**
 * @module contract-artifacts
 *
 * Contract artifact registry — declarative extension point for
 * "contracts → X" rendering (markdown / openapi / future proto / sdl /
 * asyncapi / ...).
 *
 * Replaces the v0.1 per-adapter `toMarkdown?` / `toOpenApi?` hooks which
 * (a) polluted the generic `ContractProtocolAdapter` interface with
 * protocol-specific artifacts (OpenAPI is HTTP-only), (b) had dead
 * declarations that nothing called, and (c) gave consumers no way to
 * enumerate "which artifact kinds does this project support".
 *
 * See `internal/40-discovery/proposals/contract-artifact-registry.md` (v6).
 *
 * ## Concepts
 *
 * **ArtifactKind**: first-class description of an output format (name +
 * merge strategy + empty skeleton + optional defaultRender). Per-contract
 * Part and final merged Final are independently typed (markdown renders
 * structured parts that the merge assembles into a document; openapi
 * renders per-contract partial documents that the merge stitches together).
 *
 * **ContractProtocolAdapter.artifacts**: each adapter declares which
 * kinds it produces. Mapping from kind name to per-contract renderer.
 *
 * **Consumers**: `renderArtifact(kind, contracts, options?, control?)`
 * dispatches across all registered adapters; fallback to kind.defaultRender
 * where the adapter doesn't implement the kind; ultimate fallback to
 * kind.empty when no contract contributes a part.
 *
 * ## Types
 *
 * `KnownArtifacts` / `KnownArtifactParts` / `KnownArtifactOptions` are
 * declared at the package root (`packages/sdk/src/index.ts`) so third-
 * party plugins can augment via `declare module "@glubean/sdk"`. This file
 * imports them as types from the root so declaration merging hits the
 * same node.
 */

import {
  getAdapter,
  listRegisteredProtocols,
} from "./contract-core.js";
import type {
  ExtractedContractProjection,
  VerifyRule,
} from "./contract-types.js";
import {
  emptyOpenApiDocument,
  mergeOpenApiParts,
} from "./contract-http/openapi.js";
import type {
  OpenApiDocument,
  OpenApiOptions,
} from "./contract-http/openapi.js";

// =============================================================================
// ArtifactKind
// =============================================================================

/**
 * Declarative description of an artifact format.
 *
 * @template Final    Final merged value type (what consumers receive).
 * @template Part     Per-contract partial type (what producer / defaultRender
 *                    emit). Defaults to Final; distinct when per-contract
 *                    rendering is structured (e.g. markdown produces
 *                    `{ body, feature, caseCount }` parts and the merge
 *                    assembles a feature-grouped doc string).
 * @template Options  Per-render options type. Threaded through the entire
 *                    pipeline (producer / defaultRender / merge) so kinds
 *                    whose options affect per-contract rendering (e.g. proto
 *                    `package` per message) are as well-served as kinds whose
 *                    options only affect the final merge (e.g. openapi
 *                    `title`).
 */
export interface ArtifactKind<Final, Part = Final, Options = void> {
  /** Kind identifier (snake-case or kebab-case). Unique across the registry. */
  readonly name: string;

  /**
   * Combine per-contract parts into the final artifact. Called once per
   * render; receives the collected parts and the same options that were
   * passed to producers / defaultRender.
   */
  readonly merge: (parts: Part[], options?: Options) => Final;

  /**
   * Optional fallback: when an adapter has not declared a producer for this
   * kind, use this function to render a per-contract Part from the generic
   * `ExtractedContractProjection`. Omitted for kinds that only make sense
   * for specific protocols (e.g. openapi has no defaultRender — non-HTTP
   * contracts are skipped).
   */
  readonly defaultRender?: (
    projection: ExtractedContractProjection<unknown, unknown>,
    options?: Options,
  ) => Part;

  /**
   * Required: the value returned by `renderArtifact` when no contract
   * contributes a part. Must be a valid Final. Lets `renderArtifact` promise
   * `Final` (not `Final | undefined`) and forces kind authors to think
   * about the zero-contribution scenario explicitly.
   */
  readonly empty: Final;
}

// =============================================================================
// Kind registry
// =============================================================================

const _kinds = new Map<string, ArtifactKind<unknown, unknown, unknown>>();

/**
 * Register an artifact kind by name. Idempotent when re-registering the same
 * kind object; throws when a different object tries to take the same name
 * (protects against typo-level collisions across plugins).
 *
 * `defineArtifactKind` is the ergonomic entry; this is exported for advanced
 * scenarios where a kind is built separately from its registration.
 */
export function registerArtifactKind<Final, Part, Options>(
  kind: ArtifactKind<Final, Part, Options>,
): void {
  const existing = _kinds.get(kind.name);
  if (existing) {
    if (existing !== kind) {
      throw new Error(
        `Artifact kind "${kind.name}" already registered with a different instance. ` +
          `Ensure each kind is defined exactly once per process.`,
      );
    }
    return;
  }
  _kinds.set(kind.name, kind as ArtifactKind<unknown, unknown, unknown>);
}

/**
 * Look up a registered kind by name. Used by `renderArtifactByName` and any
 * other string-driven consumer (CLI --format, MCP tool inputs, etc.).
 */
export function getArtifactKind(
  name: string,
): ArtifactKind<unknown, unknown, unknown> | undefined {
  return _kinds.get(name);
}

/** List all registered kind names (insertion order). */
export function listArtifactKinds(): string[] {
  return [..._kinds.keys()];
}

/**
 * Define and register an artifact kind in one call. Preferred entry point
 * for kind authors (SDK built-ins + first-party plugins).
 */
export function defineArtifactKind<Final, Part = Final, Options = void>(
  spec: ArtifactKind<Final, Part, Options>,
): ArtifactKind<Final, Part, Options> {
  registerArtifactKind(spec);
  return spec;
}

/**
 * Test-only: clear the kind registry. Not exposed publicly; imported by
 * `contract-artifacts.test.ts` via relative path.
 *
 * @internal
 */
export function __resetArtifactKindsForTesting(): void {
  _kinds.clear();
}

// =============================================================================
// Render pipeline
// =============================================================================

/**
 * Control knobs for a single render invocation (orthogonal to kind-specific
 * options). Kept separate from `options` so adding new flags here doesn't
 * require each kind author to know about them.
 */
export interface RenderArtifactControl {
  /**
   * Skip each adapter's `artifacts[kind]` producer even when defined; force
   * all contracts through `kind.defaultRender`. For kinds without a
   * defaultRender, contracts are skipped entirely.
   *
   * Used by CLI `--generic` for reproducible output across installed
   * plugin versions, and by tests that assert default-render behavior.
   */
  preferDefaultRender?: boolean;
}

/**
 * Summary of a render invocation — per-contract classification of how each
 * contract contributed (or was skipped) + a `usedEmptyFallback` boolean.
 */
export interface ArtifactContribution {
  contractId: string;
  protocol: string;
  /** Whether the part came from the adapter's producer or kind.defaultRender. */
  source: "explicit-producer" | "default-render";
}

export interface ArtifactSkip {
  contractId: string;
  protocol: string;
  reason: "no-producer-no-default-render" | "prefer-default-render-no-default";
}

export interface ArtifactRenderSummary<Final> {
  /** Same value `renderArtifact` would have returned. */
  value: Final;
  /** Contracts that produced a part. */
  contributions: ArtifactContribution[];
  /** Contracts that did not produce a part (with reason). */
  skipped: ArtifactSkip[];
  /**
   * True iff `value === kind.empty` was returned because zero parts were
   * collected. False when `kind.merge(parts, options)` was called. Callers
   * should use this instead of comparing `value === kind.empty`
   * themselves — merge typically returns a fresh object for object-typed
   * Final, so identity / structural equality are not reliable.
   */
  usedEmptyFallback: boolean;
}

/**
 * Core render pipeline implementation — produces both a value and a
 * detailed summary. `renderArtifact` is a thin wrapper returning just the
 * value; `renderArtifactWithSummary` returns the full summary.
 *
 * Generic type `Final` / `Part` / `Options` instead of referring to the
 * kind's generics directly so runtime-typed callers (renderArtifactByName)
 * can pass `unknown`.
 */
function runRender<Final, Part, Options>(
  kind: ArtifactKind<Final, Part, Options>,
  contracts: ReadonlyArray<ExtractedContractProjection<unknown, unknown>>,
  options: Options | undefined,
  control: RenderArtifactControl | undefined,
): ArtifactRenderSummary<Final> {
  const parts: Part[] = [];
  const contributions: ArtifactContribution[] = [];
  const skipped: ArtifactSkip[] = [];

  for (const c of contracts) {
    const adapter = getAdapter(c.protocol);
    const explicitProducer =
      !control?.preferDefaultRender
        ? (adapter?.artifacts as
            | Record<
                string,
                (
                  p: ExtractedContractProjection<unknown, unknown>,
                  options?: Options,
                ) => Part
              >
            | undefined)?.[kind.name]
        : undefined;

    if (explicitProducer) {
      parts.push(explicitProducer(c, options));
      contributions.push({
        contractId: c.id,
        protocol: c.protocol,
        source: "explicit-producer",
      });
      continue;
    }

    if (kind.defaultRender) {
      parts.push(kind.defaultRender(c, options));
      contributions.push({
        contractId: c.id,
        protocol: c.protocol,
        source: "default-render",
      });
      continue;
    }

    skipped.push({
      contractId: c.id,
      protocol: c.protocol,
      reason: control?.preferDefaultRender
        ? "prefer-default-render-no-default"
        : "no-producer-no-default-render",
    });
  }

  if (parts.length === 0) {
    return {
      value: kind.empty,
      contributions,
      skipped,
      usedEmptyFallback: true,
    };
  }

  return {
    value: kind.merge(parts, options),
    contributions,
    skipped,
    usedEmptyFallback: false,
  };
}

/**
 * Render an artifact of the given kind from a list of contracts. Threads
 * `options` through the producer / defaultRender / merge pipeline. When no
 * contract contributes a part, returns `kind.empty` (guaranteed valid
 * `Final`).
 *
 * Strong-typed entry point: kind argument is a concrete `ArtifactKind<...>`
 * object, so `options` type and return type are inferred at compile time.
 */
export function renderArtifact<Final, Part, Options>(
  kind: ArtifactKind<Final, Part, Options>,
  contracts: ReadonlyArray<ExtractedContractProjection<unknown, unknown>>,
  options?: Options,
  control?: RenderArtifactControl,
): Final {
  return runRender(kind, contracts, options, control).value;
}

/**
 * Render an artifact and return the full summary (value + contributions +
 * skipped + usedEmptyFallback). Use this when you need to distinguish
 * "zero contribution" from "merged to kind.empty-shaped value" — the
 * `usedEmptyFallback` field is the authoritative signal (do not compare
 * `value === kind.empty` yourself for object-typed Final).
 */
export function renderArtifactWithSummary<Final, Part, Options>(
  kind: ArtifactKind<Final, Part, Options>,
  contracts: ReadonlyArray<ExtractedContractProjection<unknown, unknown>>,
  options?: Options,
  control?: RenderArtifactControl,
): ArtifactRenderSummary<Final> {
  return runRender(kind, contracts, options, control);
}

/**
 * Look up a kind by name and render. Used by string-driven consumers
 * (CLI --format <name>, MCP tools, agent introspection). Throws when the
 * name is not registered — the error message includes the list of
 * registered kinds so callers can surface it without extra lookups.
 *
 * Returns `unknown` since we don't know the Final type statically;
 * callers that need a typed return should use `renderArtifact` directly
 * with the kind object they import.
 */
export function renderArtifactByName(
  kindName: string,
  contracts: ReadonlyArray<ExtractedContractProjection<unknown, unknown>>,
  options?: unknown,
  control?: RenderArtifactControl,
): unknown {
  const kind = getArtifactKind(kindName);
  if (!kind) {
    const known = listArtifactKinds();
    const hint = known.length > 0 ? known.join(", ") : "(none)";
    throw new Error(
      `Unknown artifact kind "${kindName}". Registered kinds: ${hint}`,
    );
  }
  return renderArtifact(
    kind,
    contracts,
    options,
    control,
  );
}

// =============================================================================
// Introspection
// =============================================================================

/**
 * List the protocols whose adapter **explicitly declares a producer** for
 * the given kind. Does NOT include protocols that would fall back to
 * `kind.defaultRender`. Use `listArtifactCapability` for the three-way split.
 */
export function listArtifactProducers(kindName: string): string[] {
  return listRegisteredProtocols().filter((p) => {
    const adapter = getAdapter(p);
    return (
      adapter !== undefined &&
      (adapter.artifacts as Record<string, unknown> | undefined)?.[kindName] !==
        undefined
    );
  });
}

/**
 * Static capability view — **based on installed adapters**, not on any
 * particular project's contracts. Partitions protocols into:
 *
 *   - `explicit`    : adapter declares a producer for this kind
 *   - `fallback`    : adapter has no producer but kind.defaultRender exists
 *   - `unsupported` : adapter has no producer and kind has no defaultRender
 *
 * To answer "does **this project** produce the artifact?", use
 * `renderArtifactWithSummary` and inspect `contributions` + `usedEmptyFallback`.
 * The capability view cannot know how many contracts of each protocol exist
 * in the caller's project.
 */
export function listArtifactCapability(kindName: string): {
  explicit: string[];
  fallback: string[];
  unsupported: string[];
} {
  const kind = getArtifactKind(kindName);
  const allProtocols = listRegisteredProtocols();
  const explicit = listArtifactProducers(kindName);
  const explicitSet = new Set(explicit);
  const rest = allProtocols.filter((p) => !explicitSet.has(p));
  if (kind?.defaultRender) {
    return { explicit, fallback: rest, unsupported: [] };
  }
  return { explicit, fallback: [], unsupported: rest };
}

// =============================================================================
// Built-in kinds
// =============================================================================

/**
 * OpenAPI 3.1 artifact kind. Per-contract partials are produced by HTTP
 * adapter's `artifacts.openapi` (see `contract-http/openapi.ts`); merge
 * combines them into a full spec. No `defaultRender` — non-HTTP protocols
 * don't map to OpenAPI and are skipped.
 *
 * Ported from MCP's former `contractsToOpenApi` — CAR-1 Phase 2.
 */
export const openapiArtifact = defineArtifactKind<
  OpenApiDocument,
  OpenApiDocument,
  OpenApiOptions
>({
  name: "openapi",
  merge: (parts, options) => mergeOpenApiParts(parts, options),
  empty: emptyOpenApiDocument,
});

// ---------------------------------------------------------------------------
// Markdown artifact kind
// ---------------------------------------------------------------------------
//
// Part (structured per-contract data) vs Final (rendered string) split
// lets `markdownArtifact.merge` do hasInstances-aware feature grouping +
// doc-level summary header — matching byte-for-byte the output of the
// legacy CLI `formatMdOutline(ContractStaticMeta)` path.
//
// CAR-2 port (2026-04-23): replaces the wrapper-style MarkdownPart
// shipped in CAR-1 Phase 3. Adapters can still override via
// `artifacts.markdown` for protocol-specific augmentations; the kind's
// `defaultRender` reads directly off the projection so every protocol
// gets a consistent baseline.

/**
 * Per-contract structured data consumed by `assembleMarkdownDocument`.
 * Carries raw fields; the merge step handles feature grouping,
 * instanceName-aware labeling, doc header, and summary counts.
 */
export interface MarkdownPart {
  contractId: string;
  /** Display target — equivalent to `projection.target`. */
  endpoint: string;
  protocol: string;
  description?: string;
  feature?: string;
  instanceName?: string;
  deprecated?: string;
  cases: Array<{
    key: string;
    description?: string;
    /** "active" | "deferred" | "deprecated". */
    lifecycle: "active" | "deferred" | "deprecated";
    severity: "critical" | "warning" | "info";
    defaultRun?: "always" | "opt-in";
    requires?: "headless" | "browser" | "out-of-band";
    deferredReason?: string;
    deprecatedReason?: string;
    given?: string;
    hasVerify?: boolean;
    verifyRules?: VerifyRule[];
  }>;
}

/**
 * Protocol-agnostic default renderer. Reads raw fields off the
 * projection; every protocol gets a valid Part even if its adapter
 * doesn't declare `artifacts.markdown`.
 */
export function genericMarkdownPart(
  projection: ExtractedContractProjection<unknown, unknown>,
): MarkdownPart {
  return {
    contractId: projection.id,
    endpoint: projection.target,
    protocol: projection.protocol,
    description: projection.description,
    feature: projection.feature,
    instanceName: projection.instanceName,
    deprecated: projection.deprecated,
    cases: projection.cases.map((c) => ({
      key: c.key,
      description: c.description,
      lifecycle:
        (c.lifecycle as MarkdownPart["cases"][number]["lifecycle"]) ??
        (c.deprecatedReason
          ? "deprecated"
          : c.deferredReason
            ? "deferred"
            : "active"),
      severity:
        (c.severity as MarkdownPart["cases"][number]["severity"]) ?? "warning",
      defaultRun: c.defaultRun as MarkdownPart["cases"][number]["defaultRun"],
      requires: c.requires as MarkdownPart["cases"][number]["requires"],
      deferredReason: c.deferredReason,
      deprecatedReason: c.deprecatedReason,
      given: c.given,
      hasVerify: c.hasVerify,
      verifyRules: c.verifyRules,
    })),
  };
}

// --- merge helpers (ported from CLI formatMdOutline) ------------------------

interface _ProjectionSummary {
  total: number;
  active: number;
  deferred: number;
  deprecated: number;
  gated: number;
}

function computeMarkdownSummary(parts: MarkdownPart[]): _ProjectionSummary {
  let total = 0;
  let deferred = 0;
  let deprecated = 0;
  let gated = 0;
  for (const p of parts) {
    for (const c of p.cases) {
      total++;
      if (c.lifecycle === "deprecated") deprecated++;
      else if (c.lifecycle === "deferred") deferred++;
      else if (c.requires === "browser" || c.requires === "out-of-band") gated++;
    }
  }
  return {
    total,
    active: total - deferred - deprecated - gated,
    deferred,
    deprecated,
    gated,
  };
}

function formatVerifyRule(rule: VerifyRule): string {
  if (typeof rule === "string") return rule;
  const prefix = rule.id ? `${rule.id}: ` : "";
  return `${prefix}${rule.description}`;
}

function formatCaseProjectionNotes(c: MarkdownPart["cases"][number]): string {
  const notes: string[] = [];
  if (c.given) notes.push(`given: ${c.given}`);
  if (c.verifyRules && c.verifyRules.length > 0) {
    notes.push(`verifies: ${c.verifyRules.map(formatVerifyRule).join("; ")}`);
  } else if (c.hasVerify) {
    notes.push("has verify()");
  }
  return notes.length > 0 ? ` *(${notes.join("; ")})*` : "";
}

function formatMarkdownCase(c: MarkdownPart["cases"][number]): string {
  const desc = c.description ? ` — ${c.description}` : "";
  const projectionNotes = formatCaseProjectionNotes(c);
  if (c.lifecycle === "deprecated") {
    const reason = c.deprecatedReason ?? "deprecated";
    return `- ⊘ **${c.key}** — deprecated: ${reason}${projectionNotes}`;
  }
  if (c.lifecycle === "deferred") {
    const reason = c.deferredReason ?? "deferred";
    return `- ⊘ **${c.key}** — deferred: ${reason}${projectionNotes}`;
  }
  if (c.requires === "browser" || c.requires === "out-of-band") {
    return `- ⊘ **${c.key}** — requires: ${c.requires}${projectionNotes}`;
  }
  const severityTag =
    c.severity === "critical" ? " 🔴" : c.severity === "info" ? " ℹ️" : "";
  const suffix = c.defaultRun === "opt-in" ? " *(opt-in)*" : "";
  return `- **${c.key}**${desc}${projectionNotes}${suffix}${severityTag}`;
}

/**
 * Compute the effective feature key for a part — applies the
 * instanceName-aware transform when the project has any instanced
 * contract (matches CLI `hasInstances` pre-pass behavior).
 */
function displayFeature(part: MarkdownPart, hasInstances: boolean): string {
  if (hasInstances && part.instanceName) {
    return `${part.instanceName}: ${part.feature ?? part.endpoint}`;
  }
  return part.feature ?? part.endpoint;
}

/**
 * Feature-grouped, doc-level markdown assembly. Byte-for-byte output
 * compatible with `formatMdOutline` from `packages/cli/src/commands/
 * contracts.ts` (the legacy CLI markdown path).
 *
 * Structure:
 *   # Contract Specification
 *   Generated: YYYY-MM-DD | N cases | N active | ...
 *
 *   ## <feature>
 *   🚫 **Deprecated:** ...   (if contract-level deprecated)
 *   <description or endpoint intro>
 *   - **case** — ...
 */
export function assembleMarkdownDocument(parts: MarkdownPart[]): string {
  if (parts.length === 0) return "";

  const hasInstances = parts.some((p) => !!p.instanceName);

  // Group preserving insertion order
  const groups = new Map<string, MarkdownPart[]>();
  for (const part of parts) {
    const key = displayFeature(part, hasInstances);
    const list = groups.get(key) ?? [];
    list.push(part);
    groups.set(key, list);
  }

  const summary = computeMarkdownSummary(parts);

  const lines: string[] = [];
  lines.push("# Contract Specification");
  lines.push("");
  const date = new Date().toISOString().slice(0, 10);
  const summaryParts = [`Generated: ${date}`, `${summary.total} cases`];
  if (summary.active > 0) summaryParts.push(`${summary.active} active`);
  if (summary.deferred > 0) summaryParts.push(`${summary.deferred} deferred`);
  if (summary.deprecated > 0)
    summaryParts.push(`${summary.deprecated} deprecated`);
  if (summary.gated > 0) summaryParts.push(`${summary.gated} gated`);
  lines.push(summaryParts.join(" | "));
  lines.push("");

  for (const [featureName, featureParts] of groups.entries()) {
    lines.push(`## ${featureName}`);
    lines.push("");
    for (const contract of featureParts) {
      const intro =
        contract.description ??
        (featureName !== contract.endpoint ? contract.endpoint : undefined);
      if (contract.deprecated) {
        lines.push(`🚫 **Deprecated:** ${contract.deprecated}`);
        lines.push("");
      }
      if (intro) {
        lines.push(intro);
        lines.push("");
      }
      for (const c of contract.cases) {
        lines.push(formatMarkdownCase(c));
      }
      lines.push("");
    }
  }

  return lines.join("\n").trimEnd() + "\n";
}

export const markdownArtifact = defineArtifactKind<string, MarkdownPart>({
  name: "markdown",
  defaultRender: (projection) => genericMarkdownPart(projection),
  merge: (parts) => assembleMarkdownDocument(parts),
  empty: "",
});
