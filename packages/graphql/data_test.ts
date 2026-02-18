/**
 * Tests for the fromGql data loader.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { fromGql } from "./data.ts";

Deno.test("fromGql - loads .gql file and returns trimmed content", async () => {
  const query = await fromGql("./packages/graphql/testdata/getUser.gql");
  assertEquals(query.includes("query GetUser($id: ID!)"), true);
  assertEquals(query.includes("user(id: $id)"), true);
  assertEquals(query.includes("name"), true);
  assertEquals(query.includes("email"), true);
  assertEquals(query, query.trim());
});

Deno.test("fromGql - nonexistent file throws", async () => {
  await assertRejects(() => fromGql("./nonexistent.gql"), Deno.errors.NotFound);
});
