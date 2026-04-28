/**
 * Tests for `contract-artifacts.ts` — the artifact registry + render pipeline.
 *
 * Scope covers the Phase 1 infrastructure per CAR-1 execution log:
 *   - defineArtifactKind: auto-register, idempotent, collision-throw
 *   - renderArtifact: merge happy-path, empty fallback, options full-pipeline,
 *     preferDefaultRender control
 *   - renderArtifactWithSummary: contributions/skipped classification,
 *     usedEmptyFallback boolean (including object-Final correctness)
 *   - renderArtifactByName: unknown-name throw with helpful message
 *   - listArtifactProducers / listArtifactCapability: static view over
 *     installed adapters
 *   - Part != Final type integration (mock "markdown-like" kind)
 */

import { beforeEach, describe, expect, test } from "vitest";
import {
  defineArtifactKind,
  registerArtifactKind,
  getArtifactKind,
  listArtifactKinds,
  renderArtifact,
  renderArtifactByName,
  renderArtifactWithSummary,
  listArtifactProducers,
  listArtifactCapability,
  __resetArtifactKindsForTesting,
  markdownArtifact,
} from "./contract-artifacts.js";
import type {
  ArtifactKind,
  RenderArtifactControl,
} from "./contract-artifacts.js";
import { contract, __resetAdapterRegistryForTesting } from "./contract-core.js";
import type {
  ContractProtocolAdapter,
  ExtractedContractProjection,
} from "./contract-types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal shape to pass into renderArtifact. */
function makeContract(
  protocol: string,
  id: string,
  overrides: Partial<ExtractedContractProjection<unknown, unknown>> = {},
): ExtractedContractProjection<unknown, unknown> {
  return {
    id,
    protocol,
    target: `/${id}`,
    cases: [],
    ...overrides,
  };
}

/**
 * Mock adapter factory with optional artifacts field. All runtime hooks
 * are stubbed minimally; we only need register() to succeed so that
 * `getAdapter(protocol)` returns a value with `.artifacts`.
 */
function makeAdapter(
  artifacts?: Record<
    string,
    (projection: unknown, options?: unknown) => unknown
  >,
): ContractProtocolAdapter<unknown, unknown, unknown, unknown, unknown> {
  return {
    async execute() {},
    project: () => ({ protocol: "", target: "", cases: [] }),
    normalize: (p) => ({ ...p, id: (p as { id?: string }).id ?? "" } as unknown as ExtractedContractProjection<unknown, unknown>),
    ...(artifacts ? { artifacts: artifacts as never } : {}),
  };
}

beforeEach(() => {
  __resetArtifactKindsForTesting();
  __resetAdapterRegistryForTesting();
});

// ---------------------------------------------------------------------------
// 1. defineArtifactKind + kind registry
// ---------------------------------------------------------------------------

describe("defineArtifactKind + registry", () => {
  test("defineArtifactKind auto-registers the kind", () => {
    const kind = defineArtifactKind<string>({
      name: "auto-register-case",
      merge: (parts) => parts.join(""),
      empty: "",
    });
    expect(getArtifactKind("auto-register-case")).toBe(kind);
    expect(listArtifactKinds()).toContain("auto-register-case");
  });

  test("same kind object re-registered is idempotent", () => {
    const kind = defineArtifactKind<string>({
      name: "idempotent-case",
      merge: (parts) => parts.join(""),
      empty: "",
    });
    expect(() => registerArtifactKind(kind)).not.toThrow();
    expect(getArtifactKind("idempotent-case")).toBe(kind);
  });

  test("different kind object with same name throws", () => {
    defineArtifactKind<string>({
      name: "collision-case",
      merge: (parts) => parts.join(""),
      empty: "",
    });
    const rival: ArtifactKind<string> = {
      name: "collision-case",
      merge: (parts) => parts.join("|"),
      empty: "different",
    };
    expect(() => registerArtifactKind(rival)).toThrow(
      /already registered with a different instance/,
    );
  });

  test("getArtifactKind returns undefined for unknown name", () => {
    expect(getArtifactKind("never-defined")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. renderArtifact — happy path, empty, options, preferDefaultRender
// ---------------------------------------------------------------------------

describe("renderArtifact", () => {
  test("merges producer outputs from multiple contracts", () => {
    const kind = defineArtifactKind<string>({
      name: "concat",
      merge: (parts) => parts.join("+"),
      empty: "<empty>",
    });
    contract.register(
      "p1",
      makeAdapter({ concat: (p: unknown) => `p1:${(p as { id: string }).id}` }),
    );
    contract.register(
      "p2",
      makeAdapter({ concat: (p: unknown) => `p2:${(p as { id: string }).id}` }),
    );

    const output = renderArtifact(kind, [
      makeContract("p1", "a"),
      makeContract("p2", "b"),
    ]);
    expect(output).toBe("p1:a+p2:b");
  });

  test("returns kind.empty when no contract contributes a part", () => {
    const kind = defineArtifactKind<string>({
      name: "empty-fallback",
      merge: (parts) => parts.join("+"),
      empty: "<nothing here>",
    });
    // p3 has no artifacts.empty-fallback; kind has no defaultRender.
    contract.register("p3", makeAdapter());

    const output = renderArtifact(kind, [makeContract("p3", "x")]);
    expect(output).toBe("<nothing here>");
  });

  test("falls back to kind.defaultRender when adapter has no producer", () => {
    const kind = defineArtifactKind<string>({
      name: "with-default-render",
      merge: (parts) => parts.join("|"),
      defaultRender: (p) => `default:${p.id}`,
      empty: "",
    });
    contract.register("p4", makeAdapter());

    const output = renderArtifact(kind, [
      makeContract("p4", "x"),
      makeContract("p4", "y"),
    ]);
    expect(output).toBe("default:x|default:y");
  });

  test("options is threaded to producer, defaultRender, and merge", () => {
    interface Opts {
      prefix: string;
    }
    const seen: { producer: Opts[]; defaultRender: Opts[]; merge: Opts[] } = {
      producer: [],
      defaultRender: [],
      merge: [],
    };
    const kind = defineArtifactKind<string, string, Opts>({
      name: "options-echo",
      merge: (parts, opts) => {
        if (opts) seen.merge.push(opts);
        return parts.join(",");
      },
      defaultRender: (p, opts) => {
        if (opts) seen.defaultRender.push(opts);
        return `${opts?.prefix ?? ""}default:${p.id}`;
      },
      empty: "",
    });
    contract.register(
      "p5",
      makeAdapter({
        "options-echo": (p: unknown, options?: unknown) => {
          const opts = options as Opts | undefined;
          if (opts) seen.producer.push(opts);
          return `${opts?.prefix ?? ""}prod:${(p as { id: string }).id}`;
        },
      }),
    );
    contract.register("p6", makeAdapter()); // no producer → defaultRender

    const output = renderArtifact(
      kind,
      [makeContract("p5", "a"), makeContract("p6", "b")],
      { prefix: ">>" },
    );
    expect(output).toBe(">>prod:a,>>default:b");
    expect(seen.producer).toEqual([{ prefix: ">>" }]);
    expect(seen.defaultRender).toEqual([{ prefix: ">>" }]);
    expect(seen.merge).toEqual([{ prefix: ">>" }]);
  });

  test("preferDefaultRender control bypasses explicit adapter producers", () => {
    const kind = defineArtifactKind<string>({
      name: "prefer-default",
      merge: (parts) => parts.join("/"),
      defaultRender: (p) => `default-${p.id}`,
      empty: "",
    });
    contract.register(
      "p7",
      makeAdapter({
        "prefer-default": (p: unknown) =>
          `explicit-${(p as { id: string }).id}`,
      }),
    );

    const normal = renderArtifact(kind, [makeContract("p7", "x")]);
    expect(normal).toBe("explicit-x");

    const generic = renderArtifact(
      kind,
      [makeContract("p7", "x")],
      undefined,
      { preferDefaultRender: true } satisfies RenderArtifactControl,
    );
    expect(generic).toBe("default-x");
  });

  test("preferDefaultRender with no defaultRender skips contract", () => {
    const kind = defineArtifactKind<string>({
      name: "no-default-no-explicit",
      merge: (parts) => parts.join("/"),
      empty: "<empty>",
    });
    contract.register(
      "p8",
      makeAdapter({
        "no-default-no-explicit": (p: unknown) =>
          `explicit-${(p as { id: string }).id}`,
      }),
    );

    const output = renderArtifact(
      kind,
      [makeContract("p8", "x")],
      undefined,
      { preferDefaultRender: true },
    );
    // No producer used (preferDefault forced), no defaultRender → 0 parts → empty
    expect(output).toBe("<empty>");
  });

  test("markdown default renderer surfaces given and verify markers", () => {
    contract.register("p-markdown", makeAdapter());

    const output = renderArtifact(markdownArtifact, [
      makeContract("p-markdown", "checkout", {
        target: "POST /checkout",
        feature: "checkout",
        cases: [
          {
            key: "happy",
            description: "order is accepted",
            lifecycle: "active",
            severity: "warning",
            given: "cart has inventory",
            hasVerify: true,
            verifyRules: [
              { id: "inventory", description: "inventory is reserved" },
            ],
          },
        ],
      }),
    ]);

    expect(output).toContain(
      "- **happy** — order is accepted *(given: cart has inventory; verifies: inventory: inventory is reserved)*",
    );
  });
});

// ---------------------------------------------------------------------------
// 3. renderArtifactWithSummary — contributions, skipped, usedEmptyFallback
// ---------------------------------------------------------------------------

describe("renderArtifactWithSummary", () => {
  test("records explicit-producer contributions", () => {
    const kind = defineArtifactKind<string>({
      name: "summary-explicit",
      merge: (parts) => parts.join(","),
      empty: "",
    });
    contract.register(
      "p9",
      makeAdapter({
        "summary-explicit": (p: unknown) => `v:${(p as { id: string }).id}`,
      }),
    );

    const summary = renderArtifactWithSummary(kind, [
      makeContract("p9", "a"),
      makeContract("p9", "b"),
    ]);
    expect(summary.value).toBe("v:a,v:b");
    expect(summary.contributions).toEqual([
      { contractId: "a", protocol: "p9", source: "explicit-producer" },
      { contractId: "b", protocol: "p9", source: "explicit-producer" },
    ]);
    expect(summary.skipped).toEqual([]);
    expect(summary.usedEmptyFallback).toBe(false);
  });

  test("records default-render contributions separately", () => {
    const kind = defineArtifactKind<string>({
      name: "summary-default",
      merge: (parts) => parts.join(","),
      defaultRender: (p) => `d:${p.id}`,
      empty: "",
    });
    contract.register("p10", makeAdapter()); // no producer

    const summary = renderArtifactWithSummary(kind, [
      makeContract("p10", "a"),
      makeContract("p10", "b"),
    ]);
    expect(summary.contributions).toEqual([
      { contractId: "a", protocol: "p10", source: "default-render" },
      { contractId: "b", protocol: "p10", source: "default-render" },
    ]);
    expect(summary.usedEmptyFallback).toBe(false);
  });

  test("records skipped when adapter has no producer and kind has no defaultRender", () => {
    const kind = defineArtifactKind<string>({
      name: "summary-skip",
      merge: (parts) => parts.join(","),
      empty: "",
    });
    contract.register("p11", makeAdapter()); // no producer

    const summary = renderArtifactWithSummary(kind, [
      makeContract("p11", "a"),
    ]);
    expect(summary.contributions).toEqual([]);
    expect(summary.skipped).toEqual([
      {
        contractId: "a",
        protocol: "p11",
        reason: "no-producer-no-default-render",
      },
    ]);
    expect(summary.usedEmptyFallback).toBe(true);
    expect(summary.value).toBe("");
  });

  test("usedEmptyFallback=true when zero contributions (empty contracts list)", () => {
    const kind = defineArtifactKind<string>({
      name: "summary-empty-input",
      merge: (parts) => parts.join(","),
      empty: "<empty>",
    });
    const summary = renderArtifactWithSummary(kind, []);
    expect(summary.usedEmptyFallback).toBe(true);
    expect(summary.value).toBe("<empty>");
    expect(summary.contributions).toEqual([]);
    expect(summary.skipped).toEqual([]);
  });

  test("usedEmptyFallback=false for object-Final kind with at least one contribution", () => {
    // Guards the "caller shouldn't compare value === kind.empty" case.
    // merge returns a fresh object that's not identity-equal to kind.empty;
    // usedEmptyFallback is the authoritative signal.
    interface Doc {
      items: string[];
    }
    const empty: Doc = { items: [] };
    const kind = defineArtifactKind<Doc>({
      name: "summary-object-final",
      merge: (parts) => ({ items: parts.flatMap((p) => p.items) }),
      empty,
    });
    contract.register(
      "p12",
      makeAdapter({
        "summary-object-final": (p: unknown) => ({
          items: [(p as { id: string }).id],
        }),
      }),
    );

    const summary = renderArtifactWithSummary(kind, [
      makeContract("p12", "only"),
    ]);
    expect(summary.usedEmptyFallback).toBe(false);
    expect(summary.value).toEqual({ items: ["only"] });
    // Critical: value is NOT identity-equal to kind.empty, even though it's structurally close
    expect(summary.value).not.toBe(empty);
  });

  test("preferDefaultRender skipped reason is distinct from no-producer case", () => {
    const kind = defineArtifactKind<string>({
      name: "summary-prefer-default-no-default",
      merge: (parts) => parts.join(","),
      empty: "",
    });
    contract.register(
      "p13",
      makeAdapter({
        "summary-prefer-default-no-default": (p: unknown) =>
          `x:${(p as { id: string }).id}`,
      }),
    );

    const summary = renderArtifactWithSummary(
      kind,
      [makeContract("p13", "a")],
      undefined,
      { preferDefaultRender: true },
    );
    expect(summary.skipped).toEqual([
      {
        contractId: "a",
        protocol: "p13",
        reason: "prefer-default-render-no-default",
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 4. renderArtifactByName — dynamic lookup
// ---------------------------------------------------------------------------

describe("renderArtifactByName", () => {
  test("looks up kind from registry by string name", () => {
    defineArtifactKind<string>({
      name: "by-name",
      merge: (parts) => parts.join("~"),
      empty: "",
    });
    contract.register(
      "p14",
      makeAdapter({
        "by-name": (p: unknown) => `x:${(p as { id: string }).id}`,
      }),
    );

    const output = renderArtifactByName("by-name", [
      makeContract("p14", "foo"),
    ]);
    expect(output).toBe("x:foo");
  });

  test("throws with helpful message for unknown kind name", () => {
    defineArtifactKind<string>({
      name: "registered-a",
      merge: (parts) => parts.join(""),
      empty: "",
    });
    expect(() => renderArtifactByName("does-not-exist", [])).toThrow(
      /Unknown artifact kind "does-not-exist".*registered-a/s,
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Capability introspection
// ---------------------------------------------------------------------------

describe("listArtifactProducers / listArtifactCapability", () => {
  test("listArtifactProducers returns protocols with explicit producer", () => {
    defineArtifactKind<string>({
      name: "cap-a",
      merge: (p) => p.join(""),
      empty: "",
    });
    contract.register(
      "proto1",
      makeAdapter({ "cap-a": () => "x" }),
    );
    contract.register("proto2", makeAdapter()); // no producer

    expect(listArtifactProducers("cap-a")).toEqual(["proto1"]);
  });

  test("listArtifactCapability splits explicit / fallback / unsupported", () => {
    defineArtifactKind<string>({
      name: "cap-with-default",
      merge: (p) => p.join(""),
      defaultRender: (p) => `d:${p.id}`,
      empty: "",
    });
    defineArtifactKind<string>({
      name: "cap-no-default",
      merge: (p) => p.join(""),
      empty: "",
    });
    contract.register(
      "proto_x",
      makeAdapter({ "cap-with-default": () => "" }),
    );
    contract.register("proto_y", makeAdapter()); // no producer at all

    const withDefault = listArtifactCapability("cap-with-default");
    expect(withDefault.explicit).toEqual(["proto_x"]);
    expect(withDefault.fallback).toEqual(["proto_y"]);
    expect(withDefault.unsupported).toEqual([]);

    const noDefault = listArtifactCapability("cap-no-default");
    expect(noDefault.explicit).toEqual([]);
    expect(noDefault.fallback).toEqual([]);
    expect(noDefault.unsupported).toEqual(
      expect.arrayContaining(["proto_x", "proto_y"]),
    );
  });
});

// ---------------------------------------------------------------------------
// 6. Part != Final integration (mock markdown-like kind)
// ---------------------------------------------------------------------------

describe("Part != Final types", () => {
  interface MockPart {
    body: string;
    group: string;
  }
  test("merge receives Part[] and returns distinct Final type", () => {
    const kind = defineArtifactKind<string, MockPart>({
      name: "part-differs",
      defaultRender: (p) => ({
        body: `body-${p.id}`,
        group: (p as { feature?: string }).feature ?? "default",
      }),
      merge: (parts) => {
        // Group by part.group, assemble structured doc
        const groups = new Map<string, MockPart[]>();
        for (const part of parts) {
          const list = groups.get(part.group) ?? [];
          list.push(part);
          groups.set(part.group, list);
        }
        return [...groups.entries()]
          .map(([g, ps]) => `[${g}] ${ps.map((p) => p.body).join(",")}`)
          .join(" | ");
      },
      empty: "",
    });
    contract.register("proto_md", makeAdapter());

    const output = renderArtifact(kind, [
      makeContract("proto_md", "x", { feature: "A" }),
      makeContract("proto_md", "y", { feature: "B" }),
      makeContract("proto_md", "z", { feature: "A" }),
    ]);
    expect(output).toBe("[A] body-x,body-z | [B] body-y");
  });
});
