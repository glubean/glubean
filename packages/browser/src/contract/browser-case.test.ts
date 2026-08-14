/**
 * Runtime behavior of the `browserCase` curried case factory.
 *
 * The factory is a TYPING device (it correlates `needs` with the function-valued
 * journey fields TypeScript can't correlate across sibling literal fields), so
 * its runtime job is deliberately tiny: attach the schema, and keep the schema's
 * single declaration site enforceable for JavaScript consumers too.
 *
 * Compile-time behavior (drift guard, PageType inference) lives in
 * `./types.test-d.ts`.
 */

import { test, expect } from "vitest";
import { browserCase } from "../index.js";
import type { SchemaLike } from "@glubean/sdk";

/** Minimal SchemaLike — identity parse is enough; nothing here validates. */
const needsSchema: SchemaLike<{ email: string }> = {
  safeParse: (d: unknown) => ({ success: true as const, data: d as { email: string } }),
} as SchemaLike<{ email: string }>;

test("browserCase(schema)(case) returns a new object carrying the schema as `needs`", () => {
  const action = async () => {};
  const steps = [{ id: "submit", intent: "submit the form", action }];
  const spec = {
    description: "a returning user signs in",
    entry: "/login",
    steps,
  };

  const built = browserCase(needsSchema)(spec);

  // New object — the input literal is never mutated.
  expect(built).not.toBe(spec);
  // Every authored field survives, by reference for the function-valued ones.
  expect(built.description).toBe("a returning user signs in");
  expect(built.entry).toBe("/login");
  expect(built.steps).toBe(steps);
  expect(built.steps[0]!.action).toBe(action);
  // ...plus the schema the factory owns, by reference.
  expect(built.needs).toBe(needsSchema);

  // Value-identical to writing `needs` inside the case literal — migrating an
  // existing case must not move its projection or canonicalHash.
  expect({ ...built }).toEqual({ ...spec, needs: needsSchema });
});

test("browserCase()(case) returns the case unchanged", () => {
  const spec = {
    description: "an anonymous visitor reaches the landing page",
    steps: [{ id: "visit", intent: "open the landing page" }],
  };

  const built = browserCase()(spec);

  expect(built.description).toBe("an anonymous visitor reaches the landing page");
  expect(built.steps).toBe(spec.steps);
  expect(Object.prototype.hasOwnProperty.call(built, "needs")).toBe(false);
  expect({ ...built }).toEqual({ ...spec });
});

// A literal `needs` is a compile error (`BrowserCaseBody` pins the field to
// `never`); these casts reproduce what an untyped JavaScript consumer can still
// write, and assert the runtime refuses it in BOTH forms.
type UntypedCaseFactory = (c: Record<string, unknown>) => unknown;

test("literal `needs` in the case throws — schema form", () => {
  const build = browserCase(needsSchema) as unknown as UntypedCaseFactory;

  expect(() =>
    build({
      description: "declares needs twice",
      needs: needsSchema,
      steps: [],
    }),
  ).toThrow(/do not declare `needs` inside the case literal/);
});

test("literal `needs` in the case throws — zero-arg form", () => {
  const build = browserCase() as unknown as UntypedCaseFactory;

  expect(() =>
    build({
      description: "declares needs without a factory schema",
      needs: needsSchema,
      steps: [],
    }),
  ).toThrow(/do not declare `needs` inside the case literal/);
});

// An explicit `needs: undefined` declares nothing, and the type layer admits it
// (`needs?: never` + no `exactOptionalPropertyTypes`). The runtime must agree —
// every reader of the field treats undefined as "no needs declared".
test("`needs: undefined` is tolerated — schema form overwrites it", () => {
  const built = browserCase(needsSchema)({
    description: "explicit undefined",
    needs: undefined,
    steps: [],
  });

  expect(built.needs).toBe(needsSchema);
});

test("`needs: undefined` is tolerated — zero-arg form leaves it undefined", () => {
  const built = browserCase()({
    description: "explicit undefined, no factory schema",
    needs: undefined,
    steps: [],
  });

  expect(built.needs).toBeUndefined();
});

test("the throw names the one supported declaration site", () => {
  const build = browserCase(needsSchema) as unknown as UntypedCaseFactory;

  expect(() =>
    build({ description: "x", needs: needsSchema, steps: [] }),
  ).toThrow(/browserCase\(schema\)\(\{ \.\.\. \}\)/);
});
