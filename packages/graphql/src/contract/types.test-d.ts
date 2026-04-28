/**
 * Type-level tests for GraphQL contract case factories.
 *
 * These are compile-only checks. They prove `defineGraphqlCase<Needs>` locks
 * the logical input shape across `needs`, `variables`, and `headers`.
 */

import { defineGraphqlCase } from "../index.js";
import type { SchemaLike } from "@glubean/sdk";

function s<T>(): SchemaLike<T> {
  return {} as SchemaLike<T>;
}

{
  const _good = defineGraphqlCase<{ token: string; userId: string }>({
    description: "fetch user",
    needs: s<{ token: string; userId: string }>(),
    query: "query User($id: ID!) { user(id: $id) { id } }",
    variables: ({ userId }) => ({ id: userId }),
    headers: ({ token }) => ({ authorization: `Bearer ${token}` }),
    expect: { httpStatus: 200, errors: "absent" },
  });
  void _good;

  const _variablesDrift = defineGraphqlCase<{ userId: string }>({
    description: "drift variables input",
    needs: s<{ userId: string }>(),
    query: "query User($id: ID!) { user(id: $id) { id } }",
    // @ts-expect-error -- variables input must match `{ userId: string }`.
    variables: ({ wrong }: { wrong: string }) => ({ id: wrong }),
  });
  void _variablesDrift;

  const _headersDrift = defineGraphqlCase<{ token: string }>({
    description: "drift headers input",
    needs: s<{ token: string }>(),
    query: "query Me { me { id } }",
    // @ts-expect-error -- headers input must match `{ token: string }`.
    headers: ({ missing }: { missing: string }) => ({ authorization: missing }),
  });
  void _headersDrift;
}
