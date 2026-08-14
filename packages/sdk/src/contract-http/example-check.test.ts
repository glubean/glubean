/**
 * Tests for the example ↔ schema drift warning (issue #31).
 *
 * Scope: the four checkable sites (`request.example`, `request.examples.<k>`,
 * `cases.<key>.expect.example`, `cases.<key>.expect.examples.<k>`), the
 * once-per-site guard, and the skip paths (no schema, no example, schema with
 * neither `safeParse` nor `parse`, schema that throws on its own).
 *
 * The warning fires from `adapter.normalize`, i.e. at contract construction —
 * these tests build real contracts through `contract.http.with(...)`.
 */

import { test, expect, beforeEach, afterEach, vi } from "vitest";
import { z } from "zod";
// Import from main index so the HTTP adapter side-effect registration fires.
import { contract } from "../index.js";
import type { HttpClient, SchemaLike } from "../types.js";
import { clearRegistry } from "../internal.js";
import { clearBootstrapRegistry } from "../bootstrap-registry.js";
import { __resetExampleWarningsForTesting } from "./example-check.js";

const client = {} as HttpClient;

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  clearRegistry();
  clearBootstrapRegistry();
  __resetExampleWarningsForTesting();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

/** All console.warn messages emitted so far, joined per call. */
function warnings(): string[] {
  const calls = warnSpy.mock.calls as unknown as unknown[][];
  return calls.map((args) => args.map((a) => String(a)).join(" "));
}

const UserSchema = z.object({ id: z.string(), name: z.string() });
const CreateUser = z.object({ name: z.string() });

// ---------------------------------------------------------------------------
// request.example / request.examples
// ---------------------------------------------------------------------------

test("request.example mismatching request.body warns exactly once", () => {
  const api = contract.http.with("api", { client });
  api("users.create.req-bad", {
    endpoint: "POST /users",
    request: { body: CreateUser, example: { name: 42 } },
    cases: { ok: { description: "creates", expect: { status: 201 } } },
  });

  expect(warnings()).toHaveLength(1);
  expect(warnings()[0]).toContain(`contract "users.create.req-bad"`);
  expect(warnings()[0]).toContain("request.example");
  expect(warnings()[0]).toContain("name:");
});

test("request.example matching request.body warns nothing", () => {
  const api = contract.http.with("api", { client });
  api("users.create.req-ok", {
    endpoint: "POST /users",
    request: { body: CreateUser, example: { name: "Alice" } },
    cases: { ok: { description: "creates", expect: { status: 201 } } },
  });

  expect(warnings()).toEqual([]);
});

test("request.examples map: only the drifting entry warns, keyed by name", () => {
  const api = contract.http.with("api", { client });
  api("users.create.req-map", {
    endpoint: "POST /users",
    request: {
      body: CreateUser,
      examples: {
        happy: { value: { name: "Alice" } },
        broken: { value: { name: null } },
      },
    },
    cases: { ok: { description: "creates", expect: { status: 201 } } },
  });

  expect(warnings()).toHaveLength(1);
  expect(warnings()[0]).toContain("request.examples.broken");
  expect(warnings()[0]).not.toContain("request.examples.happy");
});

test("request.body without any example warns nothing", () => {
  const api = contract.http.with("api", { client });
  api("users.create.req-none", {
    endpoint: "POST /users",
    request: { body: CreateUser },
    cases: { ok: { description: "creates", expect: { status: 201 } } },
  });

  expect(warnings()).toEqual([]);
});

test("request.example without a request.body schema warns nothing", () => {
  const api = contract.http.with("api", { client });
  api("users.create.req-schemaless", {
    endpoint: "POST /users",
    request: { example: { anything: true } },
    cases: { ok: { description: "creates", expect: { status: 201 } } },
  });

  expect(warnings()).toEqual([]);
});

// ---------------------------------------------------------------------------
// cases.<key>.expect.example / expect.examples
// ---------------------------------------------------------------------------

test("case expect.example mismatching expect.schema warns once with the case key", () => {
  const api = contract.http.with("api", { client });
  api("users.get.case-bad", {
    endpoint: "GET /users/:id",
    cases: {
      success: {
        description: "returns a user",
        expect: {
          status: 200,
          schema: UserSchema,
          example: { id: "u1" }, // missing `name`
        },
      },
    },
  });

  expect(warnings()).toHaveLength(1);
  expect(warnings()[0]).toContain(`contract "users.get.case-bad"`);
  expect(warnings()[0]).toContain(`case "success"`);
  expect(warnings()[0]).toContain("cases.success.expect.example");
});

test("case expect.example matching expect.schema warns nothing", () => {
  const api = contract.http.with("api", { client });
  api("users.get.case-ok", {
    endpoint: "GET /users/:id",
    cases: {
      success: {
        description: "returns a user",
        expect: {
          status: 200,
          schema: UserSchema,
          example: { id: "u1", name: "Alice" },
        },
      },
    },
  });

  expect(warnings()).toEqual([]);
});

test("case expect.examples map warns per drifting entry", () => {
  const api = contract.http.with("api", { client });
  api("users.get.case-map", {
    endpoint: "GET /users/:id",
    cases: {
      success: {
        description: "returns a user",
        expect: {
          status: 200,
          schema: UserSchema,
          examples: {
            happy: { value: { id: "u1", name: "Alice" } },
            legacy: { value: { id: "u1", name: 7 } },
            ancient: { value: {} },
          },
        },
      },
    },
  });

  const messages = warnings();
  expect(messages).toHaveLength(2);
  expect(messages.some((m) => m.includes("cases.success.expect.examples.legacy"))).toBe(true);
  expect(messages.some((m) => m.includes("cases.success.expect.examples.ancient"))).toBe(true);
  expect(messages.some((m) => m.includes("cases.success.expect.examples.happy"))).toBe(false);
});

// ---------------------------------------------------------------------------
// Skip paths — the check must stay silent, and must never throw
// ---------------------------------------------------------------------------

test("schema exposing neither safeParse nor parse is skipped silently", () => {
  // Hand-rolled SchemaLike with only a `jsonSchema` companion — nothing to
  // run the example through.
  const jsonSchemaOnly: SchemaLike<unknown> = {
    jsonSchema: { type: "object", properties: { name: { type: "string" } } },
  };

  const api = contract.http.with("api", { client });
  api("users.create.no-parser", {
    endpoint: "POST /users",
    request: { body: jsonSchemaOnly, example: { totally: "wrong" } },
    cases: { ok: { description: "creates", expect: { status: 201 } } },
  });

  expect(warnings()).toEqual([]);
});

test("parse-only schema drives the fallback path and still warns", () => {
  const parseOnly: SchemaLike<string> = {
    parse(data: unknown): string {
      if (typeof data !== "string") throw new Error("expected a string");
      return data;
    },
  };

  const api = contract.http.with("api", { client });
  api("users.create.parse-only", {
    endpoint: "POST /users",
    request: { body: parseOnly, example: { not: "a string" } },
    cases: { ok: { description: "creates", expect: { status: 201 } } },
  });

  expect(warnings()).toHaveLength(1);
  expect(warnings()[0]).toContain("request.example");
  expect(warnings()[0]).toContain("expected a string");
});

test("a schema whose safeParse throws is skipped, and construction survives", () => {
  const hostile: SchemaLike<unknown> = {
    safeParse() {
      throw new Error("schema exploded");
    },
  };

  const api = contract.http.with("api", { client });
  expect(() =>
    api("users.create.hostile", {
      endpoint: "POST /users",
      request: { body: hostile, example: { name: "Alice" } },
      cases: { ok: { description: "creates", expect: { status: 201 } } },
    }),
  ).not.toThrow();

  expect(warnings()).toEqual([]);
});

// ---------------------------------------------------------------------------
// Once-per-site guard
// ---------------------------------------------------------------------------

test("the same site never warns twice across repeated constructions", () => {
  const api = contract.http.with("api", { client });
  const build = () =>
    api("users.create.repeat", {
      endpoint: "POST /users",
      request: { body: CreateUser, example: { name: 42 } },
      cases: {
        success: {
          description: "creates",
          expect: { status: 201, schema: UserSchema, example: { id: 1 } },
        },
      },
    });

  build();
  expect(warnings()).toHaveLength(2); // request.example + cases.success.expect.example

  clearRegistry();
  clearBootstrapRegistry();
  build();
  expect(warnings()).toHaveLength(2); // unchanged — guard held
});

test("the same id on two scoped surfaces warns once per surface", () => {
  // `contract.http.with("a")` and `.with("b")` are different surfaces; the same
  // contract id on both is legal and they are different contracts. The
  // once-per-site guard must key on the instance too, or the second surface's
  // drift is silently swallowed.
  const a = contract.http.with("api-a", { client });
  const b = contract.http.with("api-b", { client });
  const spec = {
    endpoint: "POST /users",
    request: { body: CreateUser, example: { name: 42 } },
    cases: { ok: { description: "creates", expect: { status: 201 } } },
  } as const;

  a("users.create.shared-id", { ...spec });
  b("users.create.shared-id", { ...spec });

  const messages = warnings();
  expect(messages).toHaveLength(2);
  expect(messages.some((m) => m.includes(`instance "api-a"`))).toBe(true);
  expect(messages.some((m) => m.includes(`instance "api-b"`))).toBe(true);
});

test("symbol segments in an issue path don't swallow the warning", () => {
  const symbolKey = Symbol("secret");
  const symbolPathSchema: SchemaLike<unknown> = {
    safeParse() {
      return {
        success: false as const,
        // `Array#join` throws a TypeError on a symbol segment — pre-fix this
        // was caught by the outer guard and the warning vanished.
        error: { issues: [{ message: "Expected string", path: [symbolKey] }] },
      };
    },
  };

  const api = contract.http.with("api", { client });
  api("users.create.symbol-path", {
    endpoint: "POST /users",
    request: { body: symbolPathSchema, example: { name: 42 } },
    cases: { ok: { description: "creates", expect: { status: 201 } } },
  });

  expect(warnings()).toHaveLength(1);
  expect(warnings()[0]).toContain("Symbol(secret): Expected string");
});

// ---------------------------------------------------------------------------
// The check is advisory: projection output is untouched
// ---------------------------------------------------------------------------

test("a schema that mutates its input cannot touch the published example", () => {
  const original = { name: "Alice", nested: { keep: true } };
  const mutating: SchemaLike<unknown> = {
    safeParse(data: unknown) {
      // Hostile (or merely normalizing-in-place) schema: rewrites what it was
      // handed. If we passed the live reference, this would rewrite the
      // projection AND the canonicalHash input from inside an advisory check.
      const obj = data as Record<string, unknown>;
      obj["injected"] = true;
      delete obj["name"];
      (obj["nested"] as Record<string, unknown>)["keep"] = false;
      return { success: false as const, error: { issues: [{ message: "nope" }] } };
    },
  };

  const api = contract.http.with("api", { client });
  const c = api("users.create.mutating", {
    endpoint: "POST /users",
    request: { body: mutating, example: original },
    cases: { ok: { description: "creates", expect: { status: 201 } } },
  });

  // The check ran (so the schema really did get a value)…
  expect(warnings()).toHaveLength(1);
  // …but the author's example is byte-for-byte intact, in the live spec and in
  // the extracted projection that feeds canonicalHash.
  expect(original).toEqual({ name: "Alice", nested: { keep: true } });
  expect(c._extracted.schemas?.request?.example).toEqual({
    name: "Alice",
    nested: { keep: true },
  });
});

test("a class-instance example is skipped, not falsely reported as drift", () => {
  class Money {
    constructor(readonly amount: number) {}
    isMoney(): boolean {
      return true;
    }
  }
  const seen: unknown[] = [];
  // A schema that accepts the AUTHOR's value: `structuredClone` would hand it a
  // prototype-less copy, which fails `instanceof` — a warning would be purely an
  // artifact of our own cloning.
  const instanceSchema: SchemaLike<Money> = {
    safeParse(data: unknown) {
      seen.push(data);
      return data instanceof Money
        ? { success: true as const, data: data }
        : {
            success: false as const,
            error: { issues: [{ message: "Expected a Money instance" }] },
          };
    },
  };

  const api = contract.http.with("api", { client });
  api("payments.create.class-example", {
    endpoint: "POST /payments",
    request: { body: instanceSchema, example: new Money(42) },
    cases: { ok: { description: "pays", expect: { status: 201 } } },
  });

  expect(warnings()).toEqual([]);
  // The schema was never handed the lossy copy in the first place.
  expect(seen).toEqual([]);
});

test("a nested class instance also disqualifies the site", () => {
  class Tag {}
  let sawValue = false;
  const spy: SchemaLike<unknown> = {
    safeParse() {
      sawValue = true;
      return { success: false as const, error: { issues: [{ message: "nope" }] } };
    },
  };

  const api = contract.http.with("api", { client });
  api("payments.create.nested-class", {
    endpoint: "POST /payments",
    request: { body: spy, example: { meta: { tags: [new Tag()] } } },
    cases: { ok: { description: "pays", expect: { status: 201 } } },
  });

  expect(sawValue).toBe(false);
  expect(warnings()).toEqual([]);
});

test("a null-prototype example is skipped, not falsely reported as drift", () => {
  const seen: unknown[] = [];
  // Node's structuredClone hands back an object with `Object.prototype`, so a
  // prototype-sensitive schema accepts the author's value and rejects our copy.
  const nullProtoSchema: SchemaLike<unknown> = {
    safeParse(data: unknown) {
      seen.push(data);
      return Object.getPrototypeOf(data as object) === null
        ? { success: true as const, data }
        : {
            success: false as const,
            error: { issues: [{ message: "Expected a null-prototype object" }] },
          };
    },
  };

  const bare = Object.create(null) as Record<string, unknown>;
  bare["name"] = "Alice";

  const api = contract.http.with("api", { client });
  api("users.create.null-proto", {
    endpoint: "POST /users",
    request: { body: nullProtoSchema, example: bare },
    cases: { ok: { description: "creates", expect: { status: 201 } } },
  });

  expect(warnings()).toEqual([]);
  expect(seen).toEqual([]); // never handed the lossy copy
});

test("an example with an accessor or frozen property is skipped", () => {
  let sawValue = false;
  const spy: SchemaLike<unknown> = {
    safeParse() {
      sawValue = true;
      return { success: false as const, error: { issues: [{ message: "nope" }] } };
    },
  };

  const api = contract.http.with("api", { client });
  api("users.create.getter", {
    endpoint: "POST /users",
    // The clone materialises the getter into a plain data property.
    request: { body: spy, example: { get name() { return "Alice"; } } },
    cases: { ok: { description: "creates", expect: { status: 201 } } },
  });
  expect(sawValue).toBe(false);
  expect(warnings()).toEqual([]);

  api("users.create.frozen", {
    endpoint: "POST /users",
    // `Object.freeze` clears writable/configurable; the clone is mutable again.
    request: { body: spy, example: Object.freeze({ name: 42 }) },
    cases: { ok: { description: "creates", expect: { status: 201 } } },
  });
  expect(sawValue).toBe(false);
  expect(warnings()).toEqual([]);

  api("users.create.nested-getter", {
    endpoint: "POST /users",
    request: {
      body: spy,
      example: { meta: { get id() { return "x"; } } },
    },
    cases: { ok: { description: "creates", expect: { status: 201 } } },
  });
  expect(sawValue).toBe(false);
  expect(warnings()).toEqual([]);
});

test("a non-extensible example is skipped, not falsely reported as drift", () => {
  const seen: unknown[] = [];
  // The clone is extensible again, so an extensibility-sensitive schema accepts
  // the author's value and rejects our copy.
  const extensibilitySchema: SchemaLike<unknown> = {
    safeParse(data: unknown) {
      seen.push(data);
      return Object.isExtensible(data as object)
        ? {
            success: false as const,
            error: { issues: [{ message: "Expected a sealed payload" }] },
          }
        : { success: true as const, data };
    },
  };

  const api = contract.http.with("api", { client });

  api("users.create.prevent-extensions", {
    endpoint: "POST /users",
    // preventExtensions leaves every existing property's flags at their
    // defaults, so only the extensibility test catches it.
    request: { body: extensibilitySchema, example: Object.preventExtensions({ name: 42 }) },
    cases: { ok: { description: "creates", expect: { status: 201 } } },
  });

  api("users.create.empty-frozen", {
    endpoint: "POST /users",
    // An EMPTY frozen object has no property for the descriptor rule to catch.
    request: { body: extensibilitySchema, example: Object.freeze({}) },
    cases: { ok: { description: "creates", expect: { status: 201 } } },
  });

  api("users.create.sealed-nested", {
    endpoint: "POST /users",
    request: { body: extensibilitySchema, example: { meta: Object.seal({ id: "x" }) } },
    cases: { ok: { description: "creates", expect: { status: 201 } } },
  });

  expect(warnings()).toEqual([]);
  expect(seen).toEqual([]); // never handed the lossy copy
});

test("an array whose length was made non-writable is skipped", () => {
  let sawValue = false;
  const spy: SchemaLike<unknown> = {
    safeParse() {
      sawValue = true;
      return { success: false as const, error: { issues: [{ message: "nope" }] } };
    },
  };

  const fixedLength = [1, 2, 3];
  // Spec fixes only enumerable/configurable on `length`; writable is authorable
  // and the clone restores it to true.
  Object.defineProperty(fixedLength, "length", { writable: false });

  const api = contract.http.with("api", { client });
  api("users.list.fixed-length", {
    endpoint: "POST /users",
    request: { body: spy, example: { ids: fixedLength } },
    cases: { ok: { description: "creates", expect: { status: 201 } } },
  });

  expect(sawValue).toBe(false);
  expect(warnings()).toEqual([]);
});

test("ordinary arrays and objects are still checked (guard against over-tightening)", () => {
  const seen: unknown[] = [];
  const spy: SchemaLike<unknown> = {
    safeParse(data: unknown) {
      seen.push(data);
      return { success: false as const, error: { issues: [{ message: "nope" }] } };
    },
  };

  const api = contract.http.with("api", { client });
  api("users.list.plain-array", {
    endpoint: "POST /users",
    // Plain extensible array + nested plain object: default `length`, default
    // descriptors, extensible — must still be checked.
    request: { body: spy, example: { ids: [1, 2, 3], meta: { page: 1 } } },
    cases: { ok: { description: "creates", expect: { status: 201 } } },
  });

  expect(warnings()).toHaveLength(1);
  expect(seen).toHaveLength(1);
  expect(seen[0]).toEqual({ ids: [1, 2, 3], meta: { page: 1 } });
});

test("plain JSON examples (objects, arrays, cycles) are still checked", () => {
  const api = contract.http.with("api", { client });
  const cyclic: Record<string, unknown> = { name: 42, items: [1, 2, { deep: true }] };
  cyclic["self"] = cyclic; // structuredClone preserves cycles

  api("users.create.plain-shapes", {
    endpoint: "POST /users",
    request: { body: CreateUser, example: cyclic },
    cases: { ok: { description: "creates", expect: { status: 201 } } },
  });

  expect(warnings()).toHaveLength(1);
  expect(warnings()[0]).toContain("request.example");
});

test("dotted case keys and example names can't collide into one site", () => {
  // Rendered dotted paths collide:
  //   cases["x"].expect.examples["y.expect.example"]
  //   cases["x.expect.examples.y"].expect.example
  // both render `cases.x.expect.examples.y.expect.example`. Keying the guard on
  // that string made the second site inherit the first's mark and go silent.
  const api = contract.http.with("api", { client });
  api("users.get.collision", {
    endpoint: "GET /users/:id",
    cases: {
      x: {
        description: "named examples",
        expect: {
          status: 200,
          schema: UserSchema,
          examples: { "y.expect.example": { value: { id: 1 } } },
        },
      },
      "x.expect.examples.y": {
        description: "single example under a dotted case key",
        expect: { status: 200, schema: UserSchema, example: { id: 2 } },
      },
    },
  });

  const messages = warnings();
  expect(messages).toHaveLength(2);
  expect(messages.filter((m) => m.includes(`case "x"`))).toHaveLength(1);
  expect(messages.filter((m) => m.includes(`case "x.expect.examples.y"`))).toHaveLength(1);
});

test("an un-cloneable example is skipped rather than exposed to the schema", () => {
  let sawValue = false;
  const spy: SchemaLike<unknown> = {
    safeParse() {
      sawValue = true;
      return { success: false as const, error: { issues: [{ message: "nope" }] } };
    },
  };

  const api = contract.http.with("api", { client });
  expect(() =>
    api("users.create.uncloneable", {
      endpoint: "POST /users",
      // A function is not structured-cloneable.
      request: { body: spy, example: { callback: () => "nope" } },
      cases: { ok: { description: "creates", expect: { status: 201 } } },
    }),
  ).not.toThrow();

  expect(sawValue).toBe(false);
  expect(warnings()).toEqual([]);
});

test("a drifting example still lands verbatim in the extracted projection", () => {
  const api = contract.http.with("api", { client });
  const c = api("users.create.projection", {
    endpoint: "POST /users",
    request: { body: CreateUser, example: { name: 42 } },
    cases: { ok: { description: "creates", expect: { status: 201 } } },
  });

  expect(warnings()).toHaveLength(1);
  expect(c._extracted.schemas?.request?.example).toEqual({ name: 42 });
});
