import type {
  EachTestFunction,
  ExtensionFn,
  ResolveExtensions,
  SimpleTestFunction,
  Test,
  TestMeta,
} from "./types.js";
import { registerTest } from "./internal.js";
import { toArray } from "./data.js";
import { TestBuilder } from "./test/builder.js";
import { EachBuilder } from "./test/each-builder.js";
import { createExtendedTest } from "./test/extend.js";
import type { ExtendedTest } from "./test/extend.js";
import { normalizeEachTable, resolveBaseMeta, interpolateTemplate, selectPickExamples } from "./test/utils.js";

/**
 * Glubean SDK spec version.
 *
 * This defines the API contract between the SDK, Scanner, and Runner.
 * - Major version: Breaking changes
 * - Minor version: New features (backward compatible)
 *
 * @example
 * ```ts
 * import { SPEC_VERSION } from "@glubean/sdk";
 * console.log("SDK spec version:", SPEC_VERSION);
 * ```
 */
export const SPEC_VERSION = "2.0";

// =============================================================================
// Note: Registry functions (getRegistry, clearRegistry) have been moved to
// internal.ts to keep the public API clean. Import from "@glubean/sdk/internal"
// if you need them (for scanner or testing purposes only).
// =============================================================================

/**
 * Create a new test.
 *
 * This is the unified entry point for all test definitions.
 * Supports both quick mode (single function) and builder mode (multi-step).
 *
 * @example Quick mode (simple test)
 * ```ts
 * import { test } from "@glubean/sdk";
 *
 * export const login = test("login", async (ctx) => {
 *   const res = await ctx.http.get(`${ctx.vars.require("BASE_URL")}/login`);
 *   ctx.assert(res.ok, "Login should succeed");
 * });
 * ```
 *
 * @example Quick mode with metadata
 * ```ts
 * export const login = test(
 *   { id: "login", tags: ["auth", "smoke"] },
 *   async (ctx) => {
 *     ctx.assert(true, "works");
 *   }
 * );
 * ```
 *
 * @example Builder mode (multi-step) — .build() is optional
 * ```ts
 * export const checkout = test("checkout")
 *   .meta({ tags: ["e2e"] })
 *   .setup(async (ctx) => ({ cart: await createCart() }))
 *   .step("Add item", async (ctx, state) => { ... })
 *   .step("Pay", async (ctx, state) => { ... })
 *   .teardown(async (ctx, state) => { ... });
 * ```
 *
 * @param idOrMeta Test ID (string) or full metadata object
 * @param fn Optional test function (quick mode)
 * @returns Test object (quick mode) or TestBuilder (builder mode)
 */
export function test<S = unknown>(idOrMeta: string | TestMeta): TestBuilder<S>;
export function test(idOrMeta: string | TestMeta, fn: SimpleTestFunction): Test;
export function test<S = unknown>(
  idOrMeta: string | TestMeta,
  fn?: SimpleTestFunction,
): Test | TestBuilder<S> {
  const meta: TestMeta = typeof idOrMeta === "string"
    ? { id: idOrMeta, name: idOrMeta }
    : { name: idOrMeta.id, ...idOrMeta };

  if (meta.tags) {
    meta.tags = toArray(meta.tags);
  }

  if (fn) {
    const testDef: Test = {
      meta,
      type: "simple",
      fn,
    };

    registerTest({
      id: meta.id,
      name: meta.name || meta.id,
      type: "simple",
      tags: toArray(meta.tags),
      description: meta.description,
    });

    return testDef;
  }

  const builder = new TestBuilder<S>(meta.id);
  if (typeof idOrMeta !== "string") {
    builder.meta(idOrMeta);
  }
  return builder;
}

export namespace test {
  /**
   * Mark a test definition as focused (`only: true`).
   *
   * Works in both quick mode and builder mode.
   * If `skip` is also set on the same test, `skip` takes precedence.
   *
   * @example Quick mode
   * ```ts
   * export const focused = test.only("focused-login", async (ctx) => {
   *   ctx.expect(true).toBeTruthy();
   * });
   * ```
   *
   * @example Builder mode
   * ```ts
   * export const focusedFlow = test.only("focused-flow")
   *   .step("run", async (ctx) => {
   *     ctx.expect(true).toBeTruthy();
   *   });
   * ```
   */
  export function only<S = unknown>(idOrMeta: string | TestMeta): TestBuilder<S>;
  export function only(idOrMeta: string | TestMeta, fn: SimpleTestFunction): Test;
  export function only<S = unknown>(
    idOrMeta: string | TestMeta,
    fn?: SimpleTestFunction,
  ): Test | TestBuilder<S> {
    const baseMeta: TestMeta = typeof idOrMeta === "string" ? { id: idOrMeta, name: idOrMeta } : idOrMeta;
    const metaWithOnly: TestMeta = { ...baseMeta, only: true };
    return fn ? test(metaWithOnly, fn) : test<S>(metaWithOnly);
  }

  /**
   * Mark a test definition as skipped (`skip: true`).
   *
   * Works in both quick mode and builder mode.
   * Skip takes precedence over `only` when both are present.
   */
  export function skip<S = unknown>(idOrMeta: string | TestMeta): TestBuilder<S>;
  export function skip(idOrMeta: string | TestMeta, fn: SimpleTestFunction): Test;
  export function skip<S = unknown>(
    idOrMeta: string | TestMeta,
    fn?: SimpleTestFunction,
  ): Test | TestBuilder<S> {
    const baseMeta: TestMeta = typeof idOrMeta === "string" ? { id: idOrMeta, name: idOrMeta } : idOrMeta;
    const metaWithSkip: TestMeta = { ...baseMeta, skip: true };
    return fn ? test(metaWithSkip, fn) : test<S>(metaWithSkip);
  }

  /**
   * @deprecated Use `parallel` in TestMeta instead:
   * `test.each(table)({ id: "...", parallel: true }, fn)`
   */
  export interface EachOptions {
    parallel?: boolean;
  }

  export function each<T extends Record<string, unknown>>(
    table: readonly T[] | Record<string, T>,
    /** @deprecated Pass `parallel` in TestMeta instead. */
    options?: EachOptions,
  ): {
    (idOrMeta: string, fn: EachTestFunction<T>): Test[];
    (idOrMeta: TestMeta, fn: EachTestFunction<T>): Test[];
    (idOrMeta: string): EachBuilder<unknown, T>;
    (idOrMeta: TestMeta): EachBuilder<unknown, T>;
  } {
    const rows = normalizeEachTable(table);
    const legacyParallel = options?.parallel ?? false;
    return ((
      idOrMeta: string | TestMeta,
      fn?: EachTestFunction<T>,
    ): Test[] | EachBuilder<unknown, T> => {
      const baseMeta = resolveBaseMeta(idOrMeta);
      const parallel = baseMeta.parallel ?? legacyParallel;

      if (!fn) {
        return new EachBuilder<unknown, T>(baseMeta, rows, undefined, parallel);
      }

      const filteredTable = baseMeta.filter
        ? rows.filter((row, index) => baseMeta.filter!(row as Record<string, unknown>, index))
        : rows;

      const tagFieldNames = toArray(baseMeta.tagFields);
      const staticTags = toArray(baseMeta.tags);
      const isPick = filteredTable.length > 0 && "_pick" in filteredTable[0];
      const hasGroup = isPick || parallel;

      return filteredTable.map((row, index) => {
        const id = interpolateTemplate(baseMeta.id, row, index);
        const name = baseMeta.name ? interpolateTemplate(baseMeta.name, row, index) : id;

        const dynamicTags = tagFieldNames
          .map((field) => {
            const value = (row as Record<string, unknown>)[field];
            return value != null ? `${field}:${value}` : null;
          })
          .filter((t): t is string => t !== null);
        const allTags = [...staticTags, ...dynamicTags];

        const meta: TestMeta = {
          ...baseMeta,
          id,
          name,
          tags: allTags.length > 0 ? allTags : undefined,
        };

        const testDef: Test = {
          meta,
          type: "simple",
          fn: async (ctx) => await fn(ctx, row),
        };

        registerTest({
          id: meta.id,
          name: meta.name || meta.id,
          type: "simple",
          tags: allTags.length > 0 ? allTags : undefined,
          description: meta.description,
          ...(hasGroup ? { groupId: baseMeta.id } : {}),
          ...(parallel ? { parallel: true } : {}),
        });

        return testDef;
      });
    }) as ReturnType<typeof each<T>>;
  }

  /**
   * Example-selection API — randomly picks N examples from a named map.
   *
   * `test.pick` is a thin wrapper over `test.each`. It selects a subset of
   * examples from a `Record<string, T>`, injects a `_pick` field containing
   * the example key name, and delegates to `test.each`.
   *
   * Because the return value is identical to `test.each`, all `test.each`
   * options (`filter`, `tagFields`, `tags`) work transparently with `test.pick`.
   *
   * **Default behavior (no CLI override):** randomly selects `count` examples
   * (default 1). This provides lightweight fuzz / smoke-test coverage.
   *
   * **CLI override:** `--pick key1,key2` (or env var `GLUBEAN_PICK`) selects
   * specific examples by name, overriding random selection.
   *
   * **Run all:** `--pick all` or `--pick '*'` runs every example.
   * Recommended for CI where you want full coverage.
   *
   * **Glob patterns:** `--pick 'us-*'` selects all keys matching the pattern.
   * Useful when examples are grouped by prefix (e.g. regions, tenants).
   *
   * **VSCode integration:** CodeLens buttons let users click a specific
   * example to run, which passes `--pick <key>` under the hood.
   *
   * Use `$_pick` in the ID template to include the example key in the test ID.
   *
   * @param examples A named map of example data rows
   * @param count Number of examples to randomly select (default 1)
   * @returns Same as `test.each` — a function accepting ID template and callback
   *
   * @example Inline examples
   * ```ts
   * export const createUser = test.pick({
   *   "normal":    { name: "Alice", age: 25 },
   *   "edge-case": { name: "", age: -1 },
   *   "admin":     { name: "Admin", role: "admin" },
   * })("create-user-$_pick", async (ctx, example) => {
   *   await ctx.http.post("/api/users", { json: example });
   * });
   * ```
   *
   * @example With filter and tagFields (inherited from test.each)
   * ```ts
   * export const regionTests = test.pick(allRegions)({
   *   id: "region-$_pick",
   *   tagFields: ["currency", "_pick"],
   *   filter: (row) => row.currency === "USD",
   * }, async (ctx, data) => {
   *   const res = await ctx.http.get(data.endpoint);
   *   ctx.expect(res).toHaveStatus(200);
   * });
   * ```
   *
   * @example CLI usage
   * ```bash
   * glubean run file.ts                    # random example (default)
   * glubean run file.ts --pick normal      # specific example
   * glubean run file.ts --pick normal,admin  # multiple examples
   * glubean run file.ts --pick all         # every example (CI)
   * glubean run file.ts --pick 'us-*'      # glob pattern
   * ```
   */
  export function pick<T extends Record<string, unknown>>(
    examples: Record<string, T>,
    count = 1,
  ): ReturnType<typeof each<T & { _pick: string }>> {
    const selected = selectPickExamples(examples, count);
    return test.each(selected);
  }

  /**
   * Create an extended `test` function with augmented context.
   *
   * Inspired by Playwright's `test.extend()`. Returns a new test function
   * where `ctx` includes the resolved fixture properties alongside the
   * base `TestContext` methods.
   *
   * @example Define shared fixtures
   * ```ts
   * // tests/fixtures.ts
   * import { test as base } from "@glubean/sdk";
   *
   * export const test = base.extend({
   *   auth: (ctx) => createAuth(ctx.vars.require("AUTH_URL")),
   *   db: async (ctx, use) => {
   *     const db = await connect(ctx.vars.require("DB_URL"));
   *     await use(db);
   *     await db.disconnect();
   *   },
   * });
   * ```
   *
   * @example Use in tests
   * ```ts
   * // tests/users.test.ts
   * import { test } from "./fixtures.js";
   *
   * export const myTest = test("my-test", async (ctx) => {
   *   ctx.auth; // full autocomplete
   *   ctx.db;   // full autocomplete
   * });
   * ```
   *
   * @example Chained extend
   * ```ts
   * import { test as withAuth } from "./auth-fixtures.js";
   * export const test = withAuth.extend({ db: ... });
   * ```
   */
  export function extend<E extends Record<string, ExtensionFn<unknown>>>(
    extensions: E,
  ): ExtendedTest<import("./types.js").TestContext & ResolveExtensions<E>> {
    return createExtendedTest<import("./types.js").TestContext & ResolveExtensions<E>>(extensions);
  }
}

// =============================================================================
// Builder + data-driven re-exports
// =============================================================================
export { TestBuilder } from "./test/builder.js";
export { EachBuilder } from "./test/each-builder.js";
export type { EachStepFunction, EachSetupFunction, EachTeardownFunction } from "./test/each-builder.js";
export type { ExtendedTest } from "./test/extend.js";

// =============================================================================
// Contract API
// =============================================================================
export {
  runFlow,
  normalizeFlow,
  extractMappings,
  extractMappingsOut,
  traceComputeFn,
  getAdapter,
  rebuildExtractedProjection,
  LensPurityError,
} from "./contract-core.js";
export type {
  CaseLifecycle,
  CaseSeverity,
  CaseRequires,
  CaseDefaultRun,
  FailureKind,
  FailureClassification,
  Extensions,
  ContractProtocolAdapter,
  ContractProjection,
  ExtractedContractProjection,
  CaseMeta,
  ExtractedCaseMeta,
  ContractRegistryMeta,
  PayloadDescriptor,
  ProtocolContract,
  ContractCaseRef,
  InferInputs,
  InferOutput,
  FlowBuilder,
  FlowContract,
  FlowMeta,
  FlowRegistryMeta,
  RuntimeFlowProjection,
  RuntimeFlowStep,
  RuntimeContractCallStep,
  RuntimeComputeStep,
  ExtractedFlowProjection,
  ExtractedFlowStep,
  ExtractedContractCallStep,
  ExtractedComputeStep,
  FieldMapping,
} from "./contract-types.js";

// HTTP adapter — built-in, registers itself at SDK load time
import { contract as _contract } from "./contract-core.js";
import { httpAdapter } from "./contract-http/adapter.js";
import { createHttpRoot } from "./contract-http/factory.js";
import type { HttpContractRoot } from "./contract-http/types.js";
import type { ContractProtocolAdapter } from "./contract-types.js";
import type { FlowBuilder, FlowMeta } from "./contract-types.js";

_contract.register("http", httpAdapter);
{
  const dispatcher = _contract.http as Parameters<typeof createHttpRoot>[0];
  (_contract as unknown as { http: unknown }).http = createHttpRoot(dispatcher);
}

/**
 * The `contract` namespace — typed with built-in HTTP adapter.
 *
 *   - `contract.http.with("name", defaults)` — scoped HTTP factory (built-in)
 *   - `contract.flow(id)` — protocol-agnostic flow builder
 *   - `contract.register(protocol, adapter)` — plugin extension point
 *   - `contract[protocol](id, spec)` — attached by `register()`
 */
export const contract: {
  http: HttpContractRoot;
  flow: (idOrMeta: string | FlowMeta) => FlowBuilder<unknown>;
  register: <Spec, Rt = unknown, RtM = unknown, Sf = unknown, SfM = unknown>(
    protocol: string,
    adapter: ContractProtocolAdapter<Spec, Rt, RtM, Sf, SfM>,
  ) => void;
  [protocol: string]: unknown;
} = _contract as any;

export {
  createHttpFactory,
  createHttpRoot,
} from "./contract-http/factory.js";
export type {
  HttpContractSpec,
  HttpContractDefaults,
  HttpSecurityScheme,
  HttpContractRoot,
  HttpContractFactory,
  ContractCase,
  ContractExpect,
  ContractExample,
  NormalizedHeaders,
  ParamValue,
  RequestSpec,
  HttpPayloadSchemas,
  HttpSafeSchemas,
  HttpContractMeta,
  HttpParamSchema,
  HttpParamMeta,
  HttpFlowCaseOutput,
  InferHttpInputs,
  InferHttpOutput,
} from "./contract-http/index.js";

// =============================================================================
// Utility + plugin re-exports
// =============================================================================
export * from "./types.js";
export { fromCsv, fromDir, fromJson, fromJsonl, fromYaml, toArray } from "./data.js";
export type { FromCsvOptions, FromDirConcatOptions, FromDirOptions, FromJsonOptions, FromYamlOptions } from "./data.js";
export { configure, resolveTemplate } from "./configure.js";
export { definePlugin, defineClientFactory } from "./plugin.js";
export { installPlugin, listInstalledPlugins } from "./install-plugin.js";
// bootstrap / discoverSetupFile live in @glubean/runner — they are tool-level
// helpers for locating and loading glubean.setup.ts, not part of the SDK
// authoring surface. See runner's public exports.
// PluginManifest and ClientFactory are re-exported via `export * from "./types.js"` below.
export { defineSession, session } from "./session.js";
export { Expectation, ExpectFailError } from "./expect.js";
export type { AssertEmitter, AssertionEmission, CustomMatchers, MatcherFn, MatcherResult } from "./expect.js";
