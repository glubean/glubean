/**
 * Type-level tests for gRPC contract case factories.
 *
 * These are compile-only checks. They prove `defineGrpcCase<Needs>` locks the
 * logical input shape across `needs`, `request`, and `metadata`.
 */

import { defineGrpcCase } from "../index.js";
import type { SchemaLike } from "@glubean/sdk";

function s<T>(): SchemaLike<T> {
  return {} as SchemaLike<T>;
}

{
  const _good = defineGrpcCase<{ token: string; userId: string }>({
    description: "fetch user",
    needs: s<{ token: string; userId: string }>(),
    request: ({ userId }) => ({ userId }),
    metadata: ({ token }) => ({ authorization: `Bearer ${token}` }),
    expect: { statusCode: 0 },
  });
  void _good;

  const _requestDrift = defineGrpcCase<{ userId: string }>({
    description: "drift request input",
    needs: s<{ userId: string }>(),
    // @ts-expect-error -- request input must match `{ userId: string }`.
    request: ({ wrong }: { wrong: string }) => ({ wrong }),
  });
  void _requestDrift;

  const _metadataDrift = defineGrpcCase<{ token: string }>({
    description: "drift metadata input",
    needs: s<{ token: string }>(),
    // @ts-expect-error -- metadata input must match `{ token: string }`.
    metadata: ({ missing }: { missing: string }) => ({ authorization: missing }),
  });
  void _metadataDrift;
}
