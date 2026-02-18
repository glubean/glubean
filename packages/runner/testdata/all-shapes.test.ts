/**
 * Contract test fixture — exports every test shape the SDK supports.
 *
 * This file is imported by resolve_test.ts to verify that resolveModuleTests()
 * correctly discovers all export shapes. The test functions are no-ops because
 * we are testing discovery, not execution.
 *
 * DO NOT add `Deno.test` calls here. This is a Glubean SDK test module, not
 * a Deno test file (despite the .test.ts extension, which is the Glubean
 * convention).
 */
import { test } from "@glubean/sdk";

// ---------------------------------------------------------------------------
// 1. Simple test — id === exportName
// ---------------------------------------------------------------------------
export const health = test("health", async () => {});

// ---------------------------------------------------------------------------
// 2. Simple test — id !== exportName
// ---------------------------------------------------------------------------
export const listUsers = test({ id: "list-users", name: "List Users" }, async () => {});

// ---------------------------------------------------------------------------
// 3. Builder — un-built (no .build())
// ---------------------------------------------------------------------------
export const flow = test("flow")
  .meta({ tags: ["builder"] })
  .step("step-one", async () => {})
  .step("step-two", async () => {});

// ---------------------------------------------------------------------------
// 4. Builder — with .build()
// ---------------------------------------------------------------------------
export const flow2 = test("flow2")
  .meta({ tags: ["builder"] })
  .step("step-a", async () => {})
  .build();

// ---------------------------------------------------------------------------
// 5. test.each — simple mode (returns Test[])
// ---------------------------------------------------------------------------
export const items = test.each([
  { id: 1, name: "alpha" },
  { id: 2, name: "beta" },
])("item-$id", async () => {});

// ---------------------------------------------------------------------------
// 6. test.each — builder mode (returns EachBuilder)
// ---------------------------------------------------------------------------
export const items2 = test.each([
  { id: 1, name: "gamma" },
  { id: 2, name: "delta" },
])("item2-$id")
  .step("verify", async () => {});

// ---------------------------------------------------------------------------
// 7. test.pick — example selection
// ---------------------------------------------------------------------------
export const pick = test.pick({
  normal: { q: "hello" },
  edge: { q: "" },
})("p-$_pick", async () => {});

// ---------------------------------------------------------------------------
// 8. only flag
// ---------------------------------------------------------------------------
export const onlyTest = test({ id: "only-me", only: true }, async () => {});

// ---------------------------------------------------------------------------
// 9. skip flag
// ---------------------------------------------------------------------------
export const skipTest = test({ id: "skip-me", skip: true }, async () => {});

// ---------------------------------------------------------------------------
// 10. default export
// ---------------------------------------------------------------------------
export default test({ id: "default-test", name: "Default Export" }, async () => {});

// ---------------------------------------------------------------------------
// 11. Builder — un-built + only flag + id !== exportName
// ---------------------------------------------------------------------------
export const onlyBuilder = test("only-builder-flow")
  .meta({ only: true, tags: ["priority"] })
  .step("step-x", async () => {});

// ---------------------------------------------------------------------------
// 12. Builder — un-built + skip flag
// ---------------------------------------------------------------------------
export const skipBuilder = test("skip-builder-flow")
  .meta({ skip: true })
  .step("step-y", async () => {});
