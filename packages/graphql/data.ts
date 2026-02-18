/**
 * Data loaders for GraphQL files.
 *
 * @module data
 */

/**
 * Load a GraphQL query from a `.gql` or `.graphql` file.
 *
 * Using external `.gql` files instead of inline strings enables full IDE
 * support: syntax highlighting, field autocomplete, and schema validation
 * (when a `.graphqlrc` config points to your schema).
 *
 * @param path Path to the `.gql` / `.graphql` file, relative to project root
 * @returns The query string (trimmed)
 *
 * @example
 * ```ts
 * import { fromGql } from "@glubean/graphql/data";
 * import { graphql } from "@glubean/graphql";
 * import { test, configure } from "@glubean/sdk";
 *
 * const GetUser = await fromGql("./queries/getUser.gql");
 *
 * const { gql } = configure({
 *   plugins: {
 *     gql: graphql({ endpoint: "{{graphql_url}}" }),
 *   },
 * });
 *
 * export const getUser = test("get-user", async (ctx) => {
 *   const { data } = await gql.query(GetUser, { variables: { id: "1" } });
 *   ctx.expect(data?.user.name).toBe("Alice");
 * });
 * ```
 */
export async function fromGql(path: string): Promise<string> {
  const content = await Deno.readTextFile(path);
  return content.trim();
}
