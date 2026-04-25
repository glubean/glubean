/**
 * Integration test for Phase 2f (RFR v6 P2.1 + sibling-overlay path):
 *
 * Goes through the real public SDK API path (`contract.http.with(...)`,
 * `contract.bootstrap(...)`) so we catch projection regressions that
 * unit tests using fake carriers won't see. Specifically guards:
 *
 *   - `BaseCaseSpec.given` survives `adapter.project()` → `.normalize()` →
 *     scanner.protocolContractToNormalized → ExtractionResult
 *   - `BaseCaseSpec.runnability.requireAttachment` survives the same chain
 *     and lands as a top-level field on `NormalizedCaseMeta`, AND on
 *     `attachments[]` raw entries (proves the synthesizer reads
 *     `c.runnability` not `c.extensions.runnability`).
 *   - `hasNeeds: true` is set on cases declaring `needs` regardless of
 *     whether `needsSchema` projects.
 *   - A sibling `*.bootstrap.ts` file's `contract.bootstrap()` registration
 *     is picked up by the project-level scanner walker AND the synthesizer
 *     replaces the raw entry with a `kind: "bootstrap-overlay"` entry
 *     carrying `rawBypass` (because case declares `needs`).
 *
 * If any of these regress, the unit tests in scanner/ would still pass
 * (they construct fake carriers with the fields manually) but the
 * production projection path silently drops them — that's the exact
 * gap RFR v6 P2.1 flagged.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import { bootstrap } from "@glubean/runner";
import { extractContractsFromProject } from "@glubean/scanner";
import { __resetInstalledPluginsForTesting } from "@glubean/sdk/internal";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(HERE, "..", "..", ".tmp-attachments-integration");
let fixtureSeq = 0;
let fixtureDir: string;

beforeEach(async () => {
  fixtureSeq += 1;
  fixtureDir = join(FIXTURE_ROOT, String(fixtureSeq));
  await mkdir(fixtureDir, { recursive: true });
  __resetInstalledPluginsForTesting();
});

afterEach(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

afterAll(async () => {
  await rm(FIXTURE_ROOT, { recursive: true, force: true });
});

describe("Phase 2f — public SDK projection preserves attachment-model fields", () => {
  test("given/runnability/hasNeeds threaded HTTP → ExtractionResult; sibling overlay replaces raw", async () => {
    // glubean.setup.ts — minimal (just ensures bootstrap() resolves cleanly).
    await writeFile(
      join(fixtureDir, "glubean.setup.ts"),
      `// no-op setup\n`,
    );

    const contractsDir = join(fixtureDir, "contracts");
    await mkdir(contractsDir, { recursive: true });

    // The contract: a case with `given`, `runnability.requireAttachment`,
    // and `needs` (zod-shape so needsSchema projects). Using a custom
    // safeParse-only schema to also exercise the unprojectable-but-hasNeeds
    // path would require a separate fixture; this test focuses on the
    // happy projection path.
    // Use a hand-rolled SchemaLike (safeParse-only) so the fixture
    // doesn't need a zod dep. This also exercises the unprojectable-
    // schema branch: `hasNeeds` must still surface even though
    // schemaToJsonSchema returns null for an opaque validator.
    await writeFile(
      join(contractsDir, "users.contract.ts"),
      `
import { contract } from "@glubean/sdk";
import type { SchemaLike } from "@glubean/sdk";

const idSchema: SchemaLike<{ id: string }> = {
  safeParse: (input: unknown) => {
    if (
      typeof input === "object" &&
      input !== null &&
      typeof (input as { id?: unknown }).id === "string"
    ) {
      return { success: true, data: input as { id: string } };
    }
    return { success: false, issues: [{ path: ["id"], message: "id required" }] };
  },
};

const api = contract.http.with("usersApi", { endpoint: "https://api.example.com" });

export const getUser = api("users.get", {
  endpoint: "GET /users/:id",
  cases: {
    ok: {
      description: "fetch a user by id",
      given: "an authenticated session and an existing user with the given id",
      runnability: { requireAttachment: true },
      needs: idSchema,
      params: ({ id }: { id: string }) => ({ id }),
      expect: { status: 200 },
    },
  },
});
`,
    );

    // Sibling bootstrap file. Loading it must register the overlay so
    // synthesizer replaces the raw entry with a bootstrap-overlay entry
    // for the same testId.
    await writeFile(
      join(contractsDir, "users.bootstrap.ts"),
      `
import { contract } from "@glubean/sdk";
import { getUser } from "./users.contract.js";

export const usersGetOverlay = contract.bootstrap(
  getUser.case("ok"),
  async () => ({ id: "user-42" }),
);
`,
    );

    await bootstrap(fixtureDir);
    const result = await extractContractsFromProject(fixtureDir);

    expect(result.errors).toEqual([]);

    // ── Contract projection survival ─────────────────────────────────────
    expect(result.contracts.length).toBe(1);
    const c = result.contracts[0]!;
    expect(c.id).toBe("users.get");
    expect(c.cases.length).toBe(1);
    const caseMeta = c.cases[0]!;

    expect(caseMeta.given).toBe(
      "an authenticated session and an existing user with the given id",
    );
    expect(caseMeta.runnability).toEqual({ requireAttachment: true });
    // `hasNeeds` is set whenever the case declares `needs`, regardless of
    // whether the schema projects. The fixture uses an opaque
    // safeParse-only validator that schemaToJsonSchema can't convert,
    // so `needsSchema` is undefined — but `hasNeeds` is still true. This
    // is the P2.2 decoupling property.
    expect(caseMeta.hasNeeds).toBe(true);
    expect(caseMeta.needsSchema).toBeUndefined();

    // ── Inventory: overlay replaced raw, rawBypass present ───────────────
    expect(result.attachments.length).toBe(1); // overlay replaces raw, no flow
    const att = result.attachments[0]!;
    expect(att.kind).toBe("bootstrap-overlay");
    if (att.kind === "bootstrap-overlay") {
      expect(att.testId).toBe("users.get.ok");
      expect(att.targetRef).toEqual({ contractId: "users.get", caseKey: "ok" });
      expect(att.exportName).toBe("usersGetOverlay");
      // hasNeeds=true ⇒ rawBypass available even though schema is opaque
      expect(att.rawBypass?.available).toBe(true);
      // Opaque validator ⇒ needsSchema decoration absent (but bypass still
      // advertised — proves the P2.2 decoupling on the inventory side).
      expect(att.rawBypass?.needsSchema).toBeUndefined();
    }
  });

  test("case without overlay: raw entry carries runnability.requireAttachment from public spec", async () => {
    await writeFile(join(fixtureDir, "glubean.setup.ts"), `// no-op\n`);
    const contractsDir = join(fixtureDir, "contracts");
    await mkdir(contractsDir, { recursive: true });

    await writeFile(
      join(contractsDir, "health.contract.ts"),
      `
import { contract } from "@glubean/sdk";

const api = contract.http.with("healthApi", { endpoint: "https://api.example.com" });

export const ping = api("health.ping", {
  endpoint: "GET /ping",
  cases: {
    ok: {
      description: "service responds",
      runnability: { requireAttachment: true },
      expect: { status: 200 },
    },
  },
});
`,
    );

    await bootstrap(fixtureDir);
    const result = await extractContractsFromProject(fixtureDir);

    expect(result.errors).toEqual([]);
    expect(result.attachments.length).toBe(1);
    const att = result.attachments[0]!;
    expect(att.kind).toBe("raw");
    if (att.kind === "raw") {
      expect(att.testId).toBe("health.ping.ok");
      // Synthesizer must read this from `c.runnability`, NOT
      // `c.extensions.runnability`. If the adapter projection drops
      // runnability, this assertion fails.
      expect(att.runnability).toEqual({ requireAttachment: true });
    }
  });
});
