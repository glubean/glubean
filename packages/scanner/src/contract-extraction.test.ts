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
import { protocolContractToNormalized } from "./contract-extraction.js";

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
