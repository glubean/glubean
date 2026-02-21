# @glubean/graphql

> **Experimental** — API may change before 1.0. Feedback welcome.

GraphQL plugin for [Glubean](https://github.com/glubean/glubean) tests. Wraps `ctx.http` with `query`/`mutate` helpers,
auto-traces operations (distinguishable by name in the dashboard), and supports `{{template}}` variable resolution via
`configure()`.

## Install

```ts
import { graphql } from "jsr:@glubean/graphql";
```

Or with the import map:

```jsonc
// deno.json
{
  "imports": {
    "@glubean/graphql": "jsr:@glubean/graphql@^0.11.0"
  }
}
```

## Quick Start

```ts
import { configure, test } from "@glubean/sdk";
import { graphql } from "@glubean/graphql";

const { gql } = configure({
  plugins: {
    gql: graphql({
      endpoint: "{{graphql_url}}",
      headers: { Authorization: "Bearer {{api_key}}" },
    }),
  },
});

export const getUser = test("get-user", async (ctx) => {
  const { data, errors } = await gql.query<{ user: { name: string } }>(
    `
    query GetUser($id: ID!) {
      user(id: $id) { name }
    }
  `,
    { variables: { id: "1" } },
  );

  ctx.expect(errors).toBeUndefined();
  ctx.expect(data?.user.name).toBe("Alice");
});
```

## API

### `graphql(options)` — plugin factory

Use with `configure({ plugins })` for full template resolution and reuse across tests.

```ts
const { gql } = configure({
  plugins: {
    gql: graphql({
      endpoint: "{{graphql_url}}", // resolved from vars
      headers: { Authorization: "Bearer {{api_key}}" }, // resolved from secrets
      throwOnGraphQLErrors: true, // throw on GraphQL-level errors
    }),
  },
});
```

### `createGraphQLClient(http, options)` — standalone

Use when you don't want `configure()` — e.g. for one-off or dynamic endpoints.

```ts
import { createGraphQLClient } from "@glubean/graphql";

export const quick = test("quick-gql", async (ctx) => {
  const gql = createGraphQLClient(ctx.http, {
    endpoint: ctx.vars.require("GQL_URL"),
    headers: { Authorization: `Bearer ${ctx.secrets.require("TOKEN")}` },
  });

  const { data } = await gql.query(`{ health }`);
  ctx.assert(data?.health === "ok", "Service healthy");
});
```

### `gql` tag

Identity tagged template literal — returned string is identical to input. Enables GraphQL syntax highlighting in VS Code
(with the GraphQL extension) without any runtime cost.

```ts
import { gql } from "@glubean/graphql";

const GET_USER = gql`
  query GetUser($id: ID!) {
    user(id: $id) { name email }
  }
`;
```

### `fromGql(path)` — load from `.gql` file

Load a GraphQL query from an external `.gql` file. Useful for larger queries or when you want IDE validation with a
`.graphqlrc` schema.

```ts
import { fromGql } from "@glubean/graphql";

const GET_USER = await fromGql("./queries/get-user.gql");
const { data } = await gql.query(GET_USER, { variables: { id: "1" } });
```

## Client Methods

| Method                              | Description                |
| ----------------------------------- | -------------------------- |
| `gql.query<T>(query, options?)`     | Execute a GraphQL query    |
| `gql.mutate<T>(mutation, options?)` | Execute a GraphQL mutation |

Both return `Promise<GraphQLResponse<T>>` with shape `{ data: T \| null, errors?: GraphQLError[] }`.

## Options

| Option                 | Type                     | Default  | Description                                                |
| ---------------------- | ------------------------ | -------- | ---------------------------------------------------------- |
| `endpoint`             | `string`                 | required | GraphQL endpoint URL (supports `{{template}}`)             |
| `headers`              | `Record<string, string>` | `{}`     | Default headers for every request                          |
| `throwOnGraphQLErrors` | `boolean`                | `false`  | Throw `GraphQLResponseError` when response contains errors |

## License

MIT
