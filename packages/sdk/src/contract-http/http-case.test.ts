/**
 * Runtime behavior of the `httpCase` curried case factory.
 *
 * The factory is a TYPING device (it correlates `needs` with the function-valued
 * action fields TypeScript can't correlate across sibling literal fields), so its
 * runtime job is deliberately tiny: attach the schema, and keep the schema's
 * single declaration site enforceable for JavaScript consumers too.
 *
 * Compile-time behavior (drift guard, preserved `expect.schema` typing) lives in
 * `../attachment-model.test-d.ts` Test 5.
 */

import { test, expect } from "vitest";
import { httpCase } from "../index.js";
import type { SchemaLike } from "../types.js";

/** Minimal SchemaLike — identity parse is enough; nothing here validates. */
const needsSchema: SchemaLike<{ email: string }> = {
  safeParse: (d: unknown) => ({ success: true as const, data: d as { email: string } }),
} as SchemaLike<{ email: string }>;

test("httpCase(schema)(case) returns a new object carrying the schema as `needs`", () => {
  const body = ({ email }: { email: string }) => ({ email });
  const spec = {
    description: "creates a user",
    body,
    expect: { status: 201 },
  } as const;

  const built = httpCase(needsSchema)(spec);

  // New object — the input literal is never mutated.
  expect(built).not.toBe(spec);
  // Every authored field survives, by reference for the function-valued ones.
  expect(built.description).toBe("creates a user");
  expect(built.body).toBe(body);
  expect(built.expect).toEqual({ status: 201 });
  // ...plus the schema the factory owns, by reference.
  expect(built.needs).toBe(needsSchema);

  // Value-identical to writing `needs` inside the case literal — migrating an
  // existing case must not move its projection or canonicalHash.
  expect({ ...built }).toEqual({ ...spec, needs: needsSchema });
});

test("httpCase()(case) returns the case unchanged", () => {
  const spec = {
    description: "no content",
    expect: { status: 204 },
  } as const;

  const built = httpCase()(spec);

  expect(built.description).toBe("no content");
  expect(built.expect).toEqual({ status: 204 });
  expect(Object.prototype.hasOwnProperty.call(built, "needs")).toBe(false);
  expect({ ...built }).toEqual({ ...spec });
});

// A literal `needs` is a compile error (`HttpCaseBody` pins the field to
// `never`); these casts reproduce what an untyped JavaScript consumer can still
// write, and assert the runtime refuses it in BOTH forms.
type UntypedCaseFactory = (c: Record<string, unknown>) => unknown;

test("literal `needs` in the case throws — schema form", () => {
  const build = httpCase(needsSchema) as unknown as UntypedCaseFactory;

  expect(() =>
    build({
      description: "declares needs twice",
      needs: needsSchema,
      expect: { status: 200 },
    }),
  ).toThrow(/do not declare `needs` inside the case literal/);
});

test("literal `needs` in the case throws — zero-arg form", () => {
  const build = httpCase() as unknown as UntypedCaseFactory;

  expect(() =>
    build({
      description: "declares needs without a factory schema",
      needs: needsSchema,
      expect: { status: 204 },
    }),
  ).toThrow(/do not declare `needs` inside the case literal/);
});

// An explicit `needs: undefined` declares nothing, and the type layer admits it
// (`needs?: never` + no `exactOptionalPropertyTypes`). The runtime must agree —
// every reader of the field treats undefined as "no needs declared".
test("`needs: undefined` is tolerated — schema form overwrites it", () => {
  const built = httpCase(needsSchema)({
    description: "explicit undefined",
    needs: undefined,
    expect: { status: 200 },
  });

  expect(built.needs).toBe(needsSchema);
});

test("`needs: undefined` is tolerated — zero-arg form leaves it undefined", () => {
  const built = httpCase()({
    description: "explicit undefined, no factory schema",
    needs: undefined,
    expect: { status: 204 },
  });

  expect(built.needs).toBeUndefined();
});

test("the throw names the one supported declaration site", () => {
  const build = httpCase(needsSchema) as unknown as UntypedCaseFactory;

  expect(() =>
    build({ description: "x", needs: needsSchema, expect: { status: 200 } }),
  ).toThrow(/httpCase\(schema\)\(\{ \.\.\. \}\)/);
});
