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
} from "./contract-extraction.js";

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
// v10 attachment model: bootstrap attachment extraction (Phase 2e)
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

test("bootstrapAttachmentToNormalized splits testId into contractId + caseKey", () => {
  const normalized = bootstrapAttachmentToNormalized(
    { testId: "orders.create.success" },
    "ordersStandalone",
  );
  expect(normalized).toEqual({
    exportName: "ordersStandalone",
    kind: "bootstrap-overlay",
    testId: "orders.create.success",
    contractId: "orders.create",
    caseKey: "success",
  });
});

test("bootstrapAttachmentToNormalized splits at LAST dot (multi-segment contractId)", () => {
  // contractId can have dots (e.g. "v2.orders.create"); caseKey is the last segment.
  const normalized = bootstrapAttachmentToNormalized(
    { testId: "v2.orders.create.success" },
    "exp",
  );
  expect(normalized).toEqual({
    exportName: "exp",
    kind: "bootstrap-overlay",
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
