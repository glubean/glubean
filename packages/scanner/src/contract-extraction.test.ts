/**
 * Tests for `contract-extraction.ts` — specifically the invariant that
 * `protocolContractToNormalized` reads the adapter-produced `_extracted`
 * safe form rather than deep-recursing `_projection` via the generic
 * `deepNormalizeSchemas` fallback.
 *
 * The regression this pins: before `_extracted` was wired up, scanner fell
 * back to `deepNormalizeSchemas(_projection)` — a duck-typed recursion that
 * can't distinguish "this field is a schema (convert Zod)" from "this field
 * is a user-provided literal example (leave alone)". The adapter's own
 * `normalize()` encodes that protocol-specific knowledge; scanner MUST use it.
 */

import { test, expect } from "vitest";
import {
  bootstrapAttachmentToNormalized,
  isBootstrapAttachment,
  protocolContractToNormalized,
  synthesizeAttachments,
  type NormalizedContractMeta,
  type NormalizedFlowMeta,
} from "./contract-extraction.js";

// Helper: minimal contract carrier with one case.
function makeContract(
  id: string,
  caseKey: string,
  exportName: string,
  opts: {
    needsSchema?: unknown;
    hasNeeds?: boolean;
    requireAttachment?: boolean;
  } = {},
): NormalizedContractMeta {
  return {
    id,
    exportName,
    protocol: "http",
    target: "GET /x",
    cases: [
      {
        key: caseKey,
        lifecycle: "active",
        severity: "warning",
        // `hasNeeds` defaults to true when a `needsSchema` is provided, but
        // callers can pass `hasNeeds: true` without a projected schema to
        // simulate an unprojectable SchemaLike.
        ...(opts.hasNeeds !== undefined
          ? { hasNeeds: opts.hasNeeds }
          : opts.needsSchema !== undefined
            ? { hasNeeds: true }
            : {}),
        ...(opts.needsSchema !== undefined ? { needsSchema: opts.needsSchema } : {}),
        ...(opts.requireAttachment !== undefined
          ? { runnability: { requireAttachment: opts.requireAttachment } }
          : {}),
      },
    ],
  };
}

function makeFlow(id: string, exportName: string): NormalizedFlowMeta {
  return { id, exportName, protocol: "flow", steps: [] };
}

test("protocolContractToNormalized reads _extracted when available", () => {
  // Construct a fake carrier whose _extracted schemas differ from what
  // _projection schemas would produce under the legacy deepNormalizeSchemas
  // path. If scanner still falls back to _projection deep recursion, the
  // returned `schemas` will be { fromProjection: true } and the test fails.
  const fakeCarrier = {
    _projection: {
      id: "c1",
      protocol: "fake",
      target: "/x",
      schemas: { fromProjection: true },
      cases: [
        {
          key: "ok",
          lifecycle: "active",
          severity: "warning",
          schemas: { fromProjection: true },
        },
      ],
    },
    _extracted: {
      id: "c1",
      protocol: "fake",
      target: "/x",
      schemas: { fromExtracted: true },
      cases: [
        {
          key: "ok",
          lifecycle: "active",
          severity: "warning",
          schemas: { fromExtracted: true },
        },
      ],
    },
  };

  const normalized = protocolContractToNormalized(fakeCarrier, "exportName");
  expect(normalized.schemas).toEqual({ fromExtracted: true });
  expect(normalized.cases[0].schemas).toEqual({ fromExtracted: true });
});

// ---------------------------------------------------------------------------
// v10 attachment model: bootstrap marker recognition (Phase 2e)
// ---------------------------------------------------------------------------

test("isBootstrapAttachment recognizes the runtime marker", () => {
  expect(
    isBootstrapAttachment({
      __glubean_type: "bootstrap-attachment",
      testId: "orders.create.success",
    }),
  ).toBe(true);

  // Wrong marker
  expect(
    isBootstrapAttachment({
      __glubean_type: "contract-case-ref",
      testId: "orders.create.success",
    }),
  ).toBe(false);

  // Missing testId
  expect(
    isBootstrapAttachment({ __glubean_type: "bootstrap-attachment" }),
  ).toBe(false);

  // null / non-object
  expect(isBootstrapAttachment(null)).toBe(false);
  expect(isBootstrapAttachment("string")).toBe(false);
  expect(isBootstrapAttachment(undefined)).toBe(false);
});

test("bootstrapAttachmentToNormalized splits testId into contractId + caseKey marker", () => {
  const marker = bootstrapAttachmentToNormalized(
    { testId: "orders.create.success" },
    "ordersStandalone",
  );
  expect(marker).toEqual({
    exportName: "ordersStandalone",
    testId: "orders.create.success",
    contractId: "orders.create",
    caseKey: "success",
  });
});

test("bootstrapAttachmentToNormalized splits at LAST dot (multi-segment contractId)", () => {
  // contractId can have dots (e.g. "v2.orders.create"); caseKey is the last segment.
  const marker = bootstrapAttachmentToNormalized(
    { testId: "v2.orders.create.success" },
    "exp",
  );
  expect(marker).toEqual({
    exportName: "exp",
    testId: "v2.orders.create.success",
    contractId: "v2.orders.create",
    caseKey: "success",
  });
});

test("bootstrapAttachmentToNormalized rejects malformed testIds", () => {
  // No dot
  expect(
    bootstrapAttachmentToNormalized({ testId: "noseparator" }, "exp"),
  ).toBeNull();

  // Trailing dot
  expect(
    bootstrapAttachmentToNormalized({ testId: "orders.create." }, "exp"),
  ).toBeNull();

  // Leading dot (empty contractId)
  expect(
    bootstrapAttachmentToNormalized({ testId: ".success" }, "exp"),
  ).toBeNull();
});

// ---------------------------------------------------------------------------
// v10 attachment-model: synthesizeAttachments §7.3 inventory algorithm
// ---------------------------------------------------------------------------

test("synthesize: each case seeds a kind:'raw' entry by default", () => {
  const c = makeContract("orders.create", "success", "ordersCreate");
  const { attachments, errors } = synthesizeAttachments([c], [], []);
  expect(errors).toEqual([]);
  expect(attachments).toEqual([
    {
      kind: "raw",
      testId: "orders.create.success",
      contractId: "orders.create",
      caseKey: "success",
      exportName: "ordersCreate",
    },
  ]);
});

test("synthesize: bootstrap overlay REPLACES the raw entry for the same testId", () => {
  const c = makeContract("orders.create", "success", "ordersCreate");
  const marker = {
    exportName: "ordersStandalone",
    testId: "orders.create.success",
    contractId: "orders.create",
    caseKey: "success",
  };
  const { attachments, errors } = synthesizeAttachments([c], [], [marker]);
  expect(errors).toEqual([]);
  expect(attachments).toHaveLength(1); // raw replaced, not appended
  expect(attachments[0]).toEqual({
    kind: "bootstrap-overlay",
    testId: "orders.create.success",
    exportName: "ordersStandalone",
    targetRef: { contractId: "orders.create", caseKey: "success" },
    bootstrap: {},
  });
});

test("synthesize: rawBypass present iff target case has `needs` (hasNeeds trigger)", () => {
  const cWithNeeds = makeContract("orders.create", "ok", "createWithNeeds", {
    needsSchema: { type: "object", properties: { token: { type: "string" } } },
  });
  const cNoNeeds = makeContract("health.read", "ok", "health");

  const overlayWithNeeds = {
    exportName: "createOverlay",
    testId: "orders.create.ok",
    contractId: "orders.create",
    caseKey: "ok",
  };
  const overlayNoNeeds = {
    exportName: "healthOverlay",
    testId: "health.read.ok",
    contractId: "health.read",
    caseKey: "ok",
  };

  const { attachments } = synthesizeAttachments(
    [cWithNeeds, cNoNeeds],
    [],
    [overlayWithNeeds, overlayNoNeeds],
  );

  const withBypass = attachments.find((a) => a.testId === "orders.create.ok");
  const withoutBypass = attachments.find((a) => a.testId === "health.read.ok");

  expect(withBypass).toMatchObject({
    kind: "bootstrap-overlay",
    rawBypass: {
      available: true,
      needsSchema: { type: "object", properties: { token: { type: "string" } } },
    },
  });
  expect(withoutBypass).toMatchObject({ kind: "bootstrap-overlay" });
  expect((withoutBypass as { rawBypass?: unknown }).rawBypass).toBeUndefined();
});

test("synthesize: rawBypass surfaces even when needs schema is unprojectable (hasNeeds decouples schema)", () => {
  // Simulates the `SchemaLike<T>` case where the validator is a custom
  // safeParse/parse object that can't be converted to JSON Schema. SDK
  // normalizes hasNeeds=true, needsSchema=undefined. Inventory should
  // STILL expose rawBypass (explicit-input runtime path is valid) but
  // with `needsSchema: undefined` as the decoration.
  const cOpaqueNeeds = makeContract("orders.create", "ok", "createOpaque", {
    hasNeeds: true,
    // needsSchema deliberately omitted — simulates normalize() returning
    // undefined for a non-projectable SchemaLike.
  });
  const overlay = {
    exportName: "createOverlay",
    testId: "orders.create.ok",
    contractId: "orders.create",
    caseKey: "ok",
  };

  const { attachments } = synthesizeAttachments([cOpaqueNeeds], [], [overlay]);
  const a = attachments.find((x) => x.testId === "orders.create.ok");
  expect(a).toMatchObject({
    kind: "bootstrap-overlay",
    rawBypass: { available: true, needsSchema: undefined },
  });
});

test("synthesize: duplicate overlay surfaces a load-time error; first wins", () => {
  const c = makeContract("orders.create", "ok", "createContract");
  const m1 = {
    exportName: "firstOverlay",
    testId: "orders.create.ok",
    contractId: "orders.create",
    caseKey: "ok",
  };
  const m2 = {
    exportName: "secondOverlay",
    testId: "orders.create.ok",
    contractId: "orders.create",
    caseKey: "ok",
  };
  const { attachments, errors } = synthesizeAttachments([c], [], [m1, m2]);

  expect(errors).toHaveLength(1);
  expect(errors[0]?.error).toMatch(/Duplicate bootstrap overlay/);
  expect(errors[0]?.error).toMatch(/orders\.create\.ok/);

  // First overlay wins; second ignored.
  expect(attachments).toHaveLength(1);
  expect(attachments[0]).toMatchObject({
    kind: "bootstrap-overlay",
    exportName: "firstOverlay",
  });
});

test("synthesize: orphan overlay (no matching case) still appears as bootstrap-overlay (no rawBypass)", () => {
  // Cross-file: overlay's contract module not in the scanned set.
  const orphan = {
    exportName: "orphanOverlay",
    testId: "absent.case.ok",
    contractId: "absent.case",
    caseKey: "ok",
  };
  const { attachments } = synthesizeAttachments([], [], [orphan]);
  expect(attachments).toHaveLength(1);
  expect(attachments[0]).toEqual({
    kind: "bootstrap-overlay",
    testId: "absent.case.ok",
    exportName: "orphanOverlay",
    targetRef: { contractId: "absent.case", caseKey: "ok" },
    bootstrap: {},
  });
});

test("synthesize: flows appear as kind:'flow' alongside raw/overlay entries", () => {
  const c = makeContract("orders.create", "ok", "createContract");
  const flow = makeFlow("orders-onboarding", "onboardingFlow");
  const { attachments } = synthesizeAttachments([c], [flow], []);
  expect(attachments).toHaveLength(2);

  expect(attachments.find((a) => a.kind === "raw")).toMatchObject({
    testId: "orders.create.ok",
  });
  expect(attachments.find((a) => a.kind === "flow")).toEqual({
    kind: "flow",
    testId: "orders-onboarding",
    exportName: "onboardingFlow",
    flow,
  });
});

test("synthesize: case extensions.runnability.requireAttachment surfaces on raw", () => {
  const c = makeContract("orders.create", "needs-overlay", "createContract", {
    requireAttachment: true,
  });
  const { attachments } = synthesizeAttachments([c], [], []);
  expect(attachments[0]).toMatchObject({
    kind: "raw",
    runnability: { requireAttachment: true },
  });
});
