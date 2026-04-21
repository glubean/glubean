/**
 * @module test-extend
 *
 * Fixture extension system for augmenting `TestContext` (`test.extend()`).
 *
 * `test.extend(fixtures)` returns an `ExtendedTest` function whose `ctx`
 * includes the resolved fixture properties alongside the base `TestContext`.
 * Supports chained `.extend()`, `.each()`, and `.pick()`.
 * Also exports the `ExtendedTest` interface and `EachOptions`.
 */
import type {
  ExtensionFn,
  ResolveExtensions,
  SimpleTestFunction,
  Test,
  TestContext,
  TestMeta,
} from "../types.js";
import { registerTest } from "../internal.js";
import { toArray } from "../data.js";
import { TestBuilder } from "./builder.js";
import { EachBuilder } from "./each-builder.js";
import { normalizeEachTable, resolveBaseMeta, interpolateTemplate, selectPickExamples } from "./utils.js";

/** Keys that cannot be used as extension names (they shadow core TestContext). */
export const EXTEND_RESERVED_KEYS = new Set(["vars", "secrets", "http"]);

/**
 * An extended `test` function created by `test.extend()`.
 *
 * Behaves identically to the base `test()` but augments the context type
 * with fixture properties. Supports quick mode, builder mode, `.each()`,
 * `.pick()`, and chained `.extend()`.
 *
 * @template Ctx The augmented context type (TestContext & extensions)
 */
export interface ExtendedTest<Ctx extends TestContext> {
  /** Quick mode: single-function test with augmented context. */
  (idOrMeta: string | TestMeta, fn: (ctx: Ctx) => Promise<void>): Test;
  /** Builder mode: multi-step test with augmented context. */
  <S = unknown>(idOrMeta: string | TestMeta): TestBuilder<S, Ctx>;

  /**
   * Chain another set of extensions on top of the current ones.
   * The returned test function has `Ctx & NewExtensions` as its context type.
   */
  extend<E extends Record<string, ExtensionFn<unknown>>>(
    extensions: E,
  ): ExtendedTest<Ctx & ResolveExtensions<E>>;

  /** Data-driven tests with augmented context. */
  each<T extends Record<string, unknown>>(
    table: readonly T[],
    options?: EachOptions,
  ): {
    (
      idOrMeta: string | TestMeta,
      fn: (ctx: Ctx, data: T) => Promise<void>,
    ): Test[];
    (idOrMeta: string | TestMeta): EachBuilder<unknown, T, Ctx>;
  };

  /** Example-selection tests with augmented context. */
  pick<T extends Record<string, unknown>>(
    examples: Record<string, T>,
    count?: number,
  ): {
    (
      idOrMeta: string | TestMeta,
      fn: (ctx: Ctx, data: T & { _pick: string }) => Promise<void>,
    ): Test[];
    (
      idOrMeta: string | TestMeta,
    ): EachBuilder<unknown, T & { _pick: string }, Ctx>;
  };
}

/** @deprecated Use `parallel` in TestMeta instead. */
export interface EachOptions {
  parallel?: boolean;
}

/**
 * Create an extended test function with fixture definitions.
 * @internal
 */
export function createExtendedTest<Ctx extends TestContext>(
  allFixtures: Record<string, ExtensionFn<any>>,
): ExtendedTest<Ctx> {
  for (const key of Object.keys(allFixtures)) {
    if (EXTEND_RESERVED_KEYS.has(key)) {
      throw new Error(
        `Cannot extend test context with reserved key "${key}". ` +
          `Reserved keys: ${[...EXTEND_RESERVED_KEYS].join(", ")}.`,
      );
    }
  }

  function extTest(
    idOrMeta: string | TestMeta,
    fn?: (ctx: Ctx) => Promise<void>,
  ): Test | TestBuilder<any, Ctx> {
    if (fn) {
      const meta: TestMeta = typeof idOrMeta === "string"
        ? { id: idOrMeta, name: idOrMeta }
        : { name: idOrMeta.id, ...idOrMeta };
      if (meta.tags) meta.tags = toArray(meta.tags);

      const testDef: Test = {
        meta,
        type: "simple",
        fn: fn as unknown as SimpleTestFunction,
        fixtures: allFixtures,
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

    const id = typeof idOrMeta === "string" ? idOrMeta : idOrMeta.id;
    const builder = new TestBuilder<unknown, Ctx>(id, allFixtures);
    if (typeof idOrMeta !== "string") {
      builder.meta(idOrMeta);
    }
    return builder;
  }

  extTest.extend = <E extends Record<string, ExtensionFn<unknown>>>(
    extensions: E,
  ): ExtendedTest<Ctx & ResolveExtensions<E>> => {
    return createExtendedTest<Ctx & ResolveExtensions<E>>({
      ...allFixtures,
      ...extensions,
    });
  };

  extTest.each = <T extends Record<string, unknown>>(table: readonly T[] | Record<string, T>, options?: EachOptions) => {
    const rows = normalizeEachTable(table);
    const legacyParallel = options?.parallel ?? false;
    return ((
      idOrMeta: string | TestMeta,
      fn?: (ctx: Ctx, data: T) => Promise<void>,
    ): Test[] | EachBuilder<unknown, T, Ctx> => {
      const baseMeta = resolveBaseMeta(idOrMeta);
      const parallel = baseMeta.parallel ?? legacyParallel;

      if (!fn) {
        return new EachBuilder<unknown, T, Ctx>(baseMeta, rows, allFixtures, parallel);
      }

      const filteredTable = baseMeta.filter
        ? rows.filter((row, i) => baseMeta.filter!(row as Record<string, unknown>, i))
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
          fn: (async (ctx) => await fn(ctx as unknown as Ctx, row)) as SimpleTestFunction,
          fixtures: allFixtures,
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
    }) as ReturnType<ExtendedTest<Ctx>["each"]>;
  };

  extTest.pick = <T extends Record<string, unknown>>(
    examples: Record<string, T>,
    count = 1,
  ) => {
    const selected = selectPickExamples(examples, count);
    return extTest.each(selected);
  };

  return extTest as unknown as ExtendedTest<Ctx>;
}
