/**
 * Runtime behavior of the `grpcCase` curried case factory.
 *
 * The factory is a TYPING device (it correlates `needs` with the function-valued
 * action fields TypeScript can't correlate across sibling literal fields), so its
 * runtime job is deliberately tiny: attach the schema, and keep the schema's
 * single declaration site enforceable for JavaScript consumers too.
 *
 * Compile-time behavior (drift guard, preserved literal typing) lives in
 * `./types.test-d.ts`.
 */

import { test, expect } from "vitest";
import { grpcCase } from "../index.js";
import type { SchemaLike } from "@glubean/sdk";

/** Minimal SchemaLike — identity parse is enough; nothing here validates. */
const needsSchema: SchemaLike<{ userId: string }> = {
  safeParse: (d: unknown) => ({ success: true as const, data: d as { userId: string } }),
} as SchemaLike<{ userId: string }>;

test("grpcCase(schema)(case) returns a new object carrying the schema as `needs`", () => {
  const request = ({ userId }: { userId: string }) => ({ userId });
  const spec = {
    description: "fetches a user",
    request,
    expect: { statusCode: 0 },
  } as const;

  const built = grpcCase(needsSchema)(spec);

  // New object — the input literal is never mutated.
  expect(built).not.toBe(spec);
  // Every authored field survives, by reference for the function-valued ones.
  expect(built.description).toBe("fetches a user");
  expect(built.request).toBe(request);
  expect(built.expect).toEqual({ statusCode: 0 });
  // ...plus the schema the factory owns, by reference.
  expect(built.needs).toBe(needsSchema);

  // Value-identical to writing `needs` inside the case literal — migrating an
  // existing case must not move its projection or canonicalHash.
  expect({ ...built }).toEqual({ ...spec, needs: needsSchema });
});

test("grpcCase()(case) returns the case unchanged", () => {
  const spec = {
    description: "health probe",
    expect: { statusCode: 0 },
  } as const;

  const built = grpcCase()(spec);

  expect(built.description).toBe("health probe");
  expect(built.expect).toEqual({ statusCode: 0 });
  expect(Object.prototype.hasOwnProperty.call(built, "needs")).toBe(false);
  expect({ ...built }).toEqual({ ...spec });
});

// A literal `needs` is a compile error (`GrpcCaseBody` pins the field to
// `never`); these casts reproduce what an untyped JavaScript consumer can still
// write, and assert the runtime refuses it in BOTH forms.
type UntypedCaseFactory = (c: Record<string, unknown>) => unknown;

test("literal `needs` in the case throws — schema form", () => {
  const build = grpcCase(needsSchema) as unknown as UntypedCaseFactory;

  expect(() =>
    build({
      description: "declares needs twice",
      needs: needsSchema,
      expect: { statusCode: 0 },
    }),
  ).toThrow(/do not declare `needs` inside the case literal/);
});

test("literal `needs` in the case throws — zero-arg form", () => {
  const build = grpcCase() as unknown as UntypedCaseFactory;

  expect(() =>
    build({
      description: "declares needs without a factory schema",
      needs: needsSchema,
      expect: { statusCode: 0 },
    }),
  ).toThrow(/do not declare `needs` inside the case literal/);
});

// An explicit `needs: undefined` declares nothing, and the type layer admits it
// (`needs?: never` + no `exactOptionalPropertyTypes`). The runtime must agree —
// every reader of the field treats undefined as "no needs declared".
test("`needs: undefined` is tolerated — schema form overwrites it", () => {
  const built = grpcCase(needsSchema)({
    description: "explicit undefined",
    needs: undefined,
    expect: { statusCode: 0 },
  });

  expect(built.needs).toBe(needsSchema);
});

test("`needs: undefined` is tolerated — zero-arg form leaves it undefined", () => {
  const built = grpcCase()({
    description: "explicit undefined, no factory schema",
    needs: undefined,
    expect: { statusCode: 0 },
  });

  expect(built.needs).toBeUndefined();
});

test("the throw names the one supported declaration site", () => {
  const build = grpcCase(needsSchema) as unknown as UntypedCaseFactory;

  expect(() =>
    build({ description: "x", needs: needsSchema, expect: { statusCode: 0 } }),
  ).toThrow(/grpcCase\(schema\)\(\{ \.\.\. \}\)/);
});
