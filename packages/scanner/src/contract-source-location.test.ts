/**
 * GLU-221 phase 1 — contract/case source location (`sourceFile`/`line`/
 * `endLine`) on the RUNTIME extraction path (`extractContractFromFile` /
 * `extractContractsFromProject`).
 *
 * Background: the scanner's runtime path dynamically imports a
 * `.contract.ts` file and reads the adapter-produced `_extracted` object —
 * which has no notion of source position at all. Real (non-fabricated) line
 * numbers only exist in the STATIC AST extractor (`extractContractCases`,
 * used today as an import-failure fallback). This pins the phase-1 fix: the
 * runtime path now ALSO statically parses the same file and merges the
 * AST-derived line numbers onto the runtime-produced `NormalizedContractMeta`
 * — by contractId for the contract, by case key for each case.
 *
 * Fixtures use a locally-defined duck-typed `contract.http(...)` factory
 * (scanner has no `@glubean/sdk` dependency — it recognizes shapes, not
 * imports) written in the EXACT literal-call form the static extractor
 * requires (`contract.<protocol>("id", { cases: {...} })`) so both
 * extraction paths see the same declaration.
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { extractContractFromFile, extractContractsFromProject } from "./contract-extraction.js";

let dir: string;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** A minimal duck-typed `contract.http` factory — no @glubean/sdk needed.
 * Line numbers below are load-bearing (asserted against exactly). */
const FIXTURE = `const contract = {
  http(id, spec) {
    const cases = Object.entries(spec.cases ?? {}).map(([key, c]) => ({
      key,
      lifecycle: "active",
      severity: "warning",
      description: c?.description,
    }));
    const projection = { id, protocol: "http", target: spec.endpoint, cases };
    const arr = [];
    Object.assign(arr, { _projection: projection, _extracted: projection });
    return arr;
  },
};

export const getWidget = contract.http("get-widget", {
  endpoint: "GET /widgets/:id",
  cases: {
    ok: { description: "found" },
    notFound: { description: "missing" },
  },
});
`;
/** 1-based line of the first occurrence of `needle` in `source` — derives the
 * expected line numbers FROM the fixture text instead of hand-counting
 * (hand-counted magic numbers silently drift the first time the fixture is
 * edited; this can't). */
function lineOfSubstring(source: string, needle: string): number {
  const idx = source.indexOf(needle);
  if (idx === -1) throw new Error(`fixture drifted: ${JSON.stringify(needle)} not found`);
  return source.slice(0, idx).split("\n").length;
}

const EXPORT_LINE = lineOfSubstring(FIXTURE, "export const getWidget");
// The export statement is the last statement in the fixture — its end line
// is the fixture's last non-blank line (the closing `});`).
const EXPORT_END_LINE = FIXTURE.trim().split("\n").length;
const OK_CASE_LINE = lineOfSubstring(FIXTURE, "ok: {");
const NOT_FOUND_CASE_LINE = lineOfSubstring(FIXTURE, "notFound: {");

describe("extractContractFromFile — GLU-221 source location merge", () => {
  test("contract + case line/sourceFile/endLine are populated when projectRoot is given", async () => {
    dir = mkdtempSync(join(tmpdir(), "glubean-contract-loc-"));
    mkdirSync(join(dir, "contracts"), { recursive: true });
    const filePath = join(dir, "contracts", "widgets.contract.ts");
    writeFileSync(filePath, FIXTURE);

    const result = await extractContractFromFile(filePath, dir);
    expect(result.errors).toEqual([]);
    expect(result.contracts).toHaveLength(1);

    const contract = result.contracts[0]!;
    expect(contract.id).toBe("get-widget");
    // project-root-relative, not absolute — never leaks local FS layout.
    expect(contract.sourceFile).toBe(join("contracts", "widgets.contract.ts"));
    expect(contract.line).toBe(EXPORT_LINE);
    expect(contract.endLine).toBe(EXPORT_END_LINE);

    const ok = contract.cases.find((c) => c.key === "ok");
    const notFound = contract.cases.find((c) => c.key === "notFound");
    expect(ok?.sourceFile).toBe(join("contracts", "widgets.contract.ts"));
    expect(ok?.line).toBe(OK_CASE_LINE);
    expect(notFound?.line).toBe(NOT_FOUND_CASE_LINE);
  });

  test("backward compatible: sourceFile/line/endLine are undefined when projectRoot is omitted", async () => {
    dir = mkdtempSync(join(tmpdir(), "glubean-contract-loc-"));
    const filePath = join(dir, "widgets.contract.ts");
    writeFileSync(filePath, FIXTURE);

    // No projectRoot passed — matches every call site before GLU-221 and
    // any caller that doesn't yet know its project root.
    const result = await extractContractFromFile(filePath);
    expect(result.contracts).toHaveLength(1);
    const contract = result.contracts[0]!;
    expect(contract.sourceFile).toBeUndefined();
    // Real line numbers are still resolvable from the AST even without a
    // projectRoot (only `sourceFile`'s relativity depends on it) — the
    // merge itself isn't gated on projectRoot, only the path shape is.
    expect(contract.line).toBe(EXPORT_LINE);
  });

  test("scoped/custom factory form: runtime extraction still succeeds, but no line is fabricated", async () => {
    dir = mkdtempSync(join(tmpdir(), "glubean-contract-loc-"));
    const filePath = join(dir, "widgets.contract.ts");
    // `api.get(...)` instead of the literal `contract.<protocol>(...)` the
    // narrow static extractor recognizes — same "fail closed on scoped/
    // custom forms" discipline the fallback path already documents.
    writeFileSync(
      filePath,
      `const api = {
  get(id, spec) {
    const projection = { id, protocol: "http", target: spec.endpoint, cases: [] };
    const arr = [];
    Object.assign(arr, { _projection: projection, _extracted: projection });
    return arr;
  },
};

export const getWidget = api.get("get-widget", { endpoint: "GET /widgets/:id" });
`,
    );

    const result = await extractContractFromFile(filePath, dir);
    expect(result.contracts).toHaveLength(1);
    const contract = result.contracts[0]!;
    expect(contract.id).toBe("get-widget");
    // Runtime extraction (id/protocol/target) is untouched by this change —
    // only the location fields are best-effort/absent here.
    expect(contract.protocol).toBe("http");
    expect(contract.sourceFile).toBe("widgets.contract.ts");
    expect(contract.line).toBeUndefined();
    expect(contract.endLine).toBeUndefined();
  });
});

/** Two literal `contract.http(...)` exports that share the SAME
 * author-chosen `contractId` ("shared-id") but different export names/case
 * keys — the fixture for the P2-3 regression test below. */
const DUP_ID_FIXTURE = `const contract = {
  http(id, spec) {
    const cases = Object.entries(spec.cases ?? {}).map(([key, c]) => ({
      key,
      lifecycle: "active",
      severity: "warning",
      description: c?.description,
    }));
    const projection = { id, protocol: "http", target: spec.endpoint, cases };
    const arr = [];
    Object.assign(arr, { _projection: projection, _extracted: projection });
    return arr;
  },
};

export const contractA = contract.http("shared-id", {
  endpoint: "GET /a",
  cases: {
    aOk: { description: "a-ok" },
  },
});

export const contractB = contract.http("shared-id", {
  endpoint: "GET /b",
  cases: {
    bOk: { description: "b-ok" },
  },
});
`;
const A_EXPORT_LINE = lineOfSubstring(DUP_ID_FIXTURE, "export const contractA");
const B_EXPORT_LINE = lineOfSubstring(DUP_ID_FIXTURE, "export const contractB");
const A_CASE_LINE = lineOfSubstring(DUP_ID_FIXTURE, "aOk: {");
const B_CASE_LINE = lineOfSubstring(DUP_ID_FIXTURE, "bOk: {");

describe("extractContractFromFile — GLU-221 phase 1 P2-3: two contracts sharing a contractId", () => {
  test("static line lookup is keyed by (contractId, exportName, protocol) — no cross-assignment between contracts that share an author-chosen id", async () => {
    dir = mkdtempSync(join(tmpdir(), "glubean-contract-loc-dupid-"));
    const filePath = join(dir, "widgets.contract.ts");
    writeFileSync(filePath, DUP_ID_FIXTURE);

    const result = await extractContractFromFile(filePath, dir);
    expect(result.errors).toEqual([]);
    expect(result.contracts).toHaveLength(2);

    const a = result.contracts.find((c) => c.exportName === "contractA");
    const b = result.contracts.find((c) => c.exportName === "contractB");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.id).toBe("shared-id");
    expect(b!.id).toBe("shared-id");

    // Before the P2-3 fix, `staticContractLocations` was keyed by
    // contractId ALONE — the second `extractContractCases` entry (contractB's)
    // silently overwrote the first in the lookup Map, so EVERY contract
    // sharing "shared-id" resolved to whichever entry was inserted last,
    // regardless of which export it actually was.
    expect(a!.line).toBe(A_EXPORT_LINE);
    expect(b!.line).toBe(B_EXPORT_LINE);
    expect(a!.line).not.toBe(b!.line);

    const aCase = a!.cases.find((c) => c.key === "aOk");
    const bCase = b!.cases.find((c) => c.key === "bOk");
    expect(aCase?.line).toBe(A_CASE_LINE);
    expect(bCase?.line).toBe(B_CASE_LINE);
  });
});

describe("extractContractsFromProject — GLU-221 source location merge (project-level)", () => {
  test("contracts across multiple files each carry a project-root-relative sourceFile", async () => {
    dir = mkdtempSync(join(tmpdir(), "glubean-contract-loc-project-"));
    mkdirSync(join(dir, "a"), { recursive: true });
    mkdirSync(join(dir, "b"), { recursive: true });
    writeFileSync(join(dir, "a", "widgets.contract.ts"), FIXTURE);
    writeFileSync(
      join(dir, "b", "other.contract.ts"),
      FIXTURE.replace(/get-widget/g, "get-other").replace("getWidget", "getOther"),
    );

    const result = await extractContractsFromProject(dir);
    expect(result.errors).toEqual([]);
    expect(result.contracts).toHaveLength(2);

    const widgets = result.contracts.find((c) => c.id === "get-widget");
    const other = result.contracts.find((c) => c.id === "get-other");
    expect(widgets?.sourceFile).toBe(join("a", "widgets.contract.ts"));
    expect(widgets?.line).toBe(EXPORT_LINE);
    expect(other?.sourceFile).toBe(join("b", "other.contract.ts"));
    expect(other?.line).toBe(EXPORT_LINE);
  });
});
