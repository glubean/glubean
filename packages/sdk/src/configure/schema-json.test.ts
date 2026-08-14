/**
 * Tests for the schema-aware `.json(schema)` on the `configure()` HTTP client
 * (issue #32).
 *
 * The underlying response promise comes from the runner/engine (ky's
 * `ResponsePromise`); here a fake runtime supplies a ky-shaped double so the
 * decoration itself is under test: schema form validates, no-arg form is
 * untouched, `.track()` and `.extend()` keep the capability.
 */

import { test, expect, afterEach } from "vitest";
import { z } from "zod";
import { configure } from "../configure.js";
import { CONFIGURED_HTTP_CLIENT, SCHEMA_JSON_ATTACHED } from "../types.js";
import { parseWithSchema } from "./schema-json.js";
import {
  setRuntime as carrierSetRuntime,
  type InternalRuntime,
} from "../runtime-carrier.js";
import type { HttpClient, SchemaLike } from "../types.js";

// ---------------------------------------------------------------------------
// ky-shaped test double
// ---------------------------------------------------------------------------

interface FakeCall {
  method: string;
  url: string;
  tracked: string[];
}

/** A promise carrying ky's body shortcuts (`json` / `text`) plus `.track()`. */
function makeResponsePromise(body: unknown, tracked: string[]) {
  const promise = Promise.resolve({ status: 200 } as unknown as Response) as Promise<Response> & {
    json: () => Promise<unknown>;
    text: () => Promise<string>;
    track: (pattern: string) => unknown;
  };
  promise.json = async () => body;
  promise.text = async () => JSON.stringify(body);
  promise.track = (pattern: string) => {
    tracked.push(pattern);
    return promise;
  };
  return promise;
}

function makeRuntimeHttp(body: unknown, calls: FakeCall[] = []): HttpClient {
  const tracked: string[] = [];
  const respond = (method: string) => (url: string | URL | Request) => {
    calls.push({ method, url: String(url), tracked });
    return makeResponsePromise(body, tracked);
  };
  const client = respond("get") as unknown as Record<string, unknown>;
  for (const method of ["get", "post", "put", "patch", "delete", "head"]) {
    client[method] = respond(method);
  }
  client["extend"] = () => makeRuntimeHttp(body, calls);
  return client as unknown as HttpClient;
}

function installRuntime(body: unknown, calls: FakeCall[] = []): () => void {
  const runtime: InternalRuntime = {
    vars: {},
    secrets: {},
    session: {},
    http: makeRuntimeHttp(body, calls),
  };
  carrierSetRuntime(runtime);
  return () => carrierSetRuntime(undefined);
}

afterEach(() => {
  carrierSetRuntime(undefined);
});

const UserSchema = z.object({ id: z.string(), name: z.string() });

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test("json(schema) returns the validated value", async () => {
  const cleanup = installRuntime({ id: "u1", name: "Alice" });
  try {
    const { http } = configure({});
    const user = await http.get("users/1").json(UserSchema);
    expect(user).toEqual({ id: "u1", name: "Alice" });
    // Typed as z.infer<typeof UserSchema> — no cast needed.
    const id: string = user.id;
    expect(id).toBe("u1");
  } finally {
    cleanup();
  }
});

test("json(schema) returns the schema's PARSED output, not the raw body", async () => {
  const cleanup = installRuntime({ count: "42" });
  try {
    const { http } = configure({});
    const Coerced = z.object({ count: z.coerce.number() });
    const parsed = await http.get("stats").json(Coerced);
    expect(parsed).toEqual({ count: 42 });
  } finally {
    cleanup();
  }
});

test("json(schema) works on the configured (extend-backed) client too", async () => {
  const cleanup = installRuntime({ id: "u1", name: "Alice" });
  try {
    const { http } = configure({ http: { prefixUrl: "https://api.example.com" } });
    const user = await http.get("users/1").json(UserSchema);
    expect(user).toEqual({ id: "u1", name: "Alice" });
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Failure modes
// ---------------------------------------------------------------------------

test("json(schema) throws exactly what a parse-style schema throws", async () => {
  const cleanup = installRuntime({ id: "u1" });
  try {
    const { http } = configure({});
    await expect(http.get("users/1").json(UserSchema)).rejects.toBeInstanceOf(z.ZodError);
  } finally {
    cleanup();
  }
});

test("json(schema) throws an issue-summary Error for a safeParse-only schema", async () => {
  const cleanup = installRuntime({ id: 7 });
  try {
    const safeParseOnly: SchemaLike<{ id: string }> = {
      safeParse(data: unknown) {
        const id = (data as { id?: unknown })?.id;
        return typeof id === "string"
          ? { success: true as const, data: { id } }
          : {
              success: false as const,
              error: { issues: [{ message: "Expected string", path: ["id"] }] },
            };
      },
    };

    const { http } = configure({});
    await expect(http.get("users/1").json(safeParseOnly)).rejects.toThrow(
      /Schema validation failed — id: Expected string/,
    );
  } finally {
    cleanup();
  }
});

test("json(schema) rejects a schema with neither parse nor safeParse", async () => {
  const cleanup = installRuntime({ id: "u1" });
  try {
    const { http } = configure({});
    const useless = { jsonSchema: { type: "object" } } as SchemaLike<unknown>;
    await expect(http.get("users/1").json(useless)).rejects.toBeInstanceOf(TypeError);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Unchanged surface
// ---------------------------------------------------------------------------

test("no-arg json<T>() is unchanged — decoded body, no validation", async () => {
  const cleanup = installRuntime({ id: 7, unexpected: true });
  try {
    const { http } = configure({});
    const raw = await http.get("users/1").json<unknown>();
    expect(raw).toEqual({ id: 7, unexpected: true });
  } finally {
    cleanup();
  }
});

test("other body shortcuts and awaiting the response still work", async () => {
  const cleanup = installRuntime({ id: "u1", name: "Alice" });
  try {
    const { http } = configure({});
    const text = await http.get("users/1").text();
    expect(text).toBe(JSON.stringify({ id: "u1", name: "Alice" }));

    const res = await http.get("users/1");
    expect(res.status).toBe(200);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Chaining
// ---------------------------------------------------------------------------

test("json(schema) survives a .track(...) chain", async () => {
  const calls: FakeCall[] = [];
  const cleanup = installRuntime({ id: "u1", name: "Alice" }, calls);
  try {
    const { http } = configure({});
    const user = await http.get("users/u1").track("GET /users/:id").json(UserSchema);
    expect(user).toEqual({ id: "u1", name: "Alice" });
    expect(calls[0]?.tracked).toEqual(["GET /users/:id"]);
  } finally {
    cleanup();
  }
});

test("json(schema) survives .extend() on the configured client", async () => {
  const cleanup = installRuntime({ id: "u1", name: "Alice" });
  try {
    const { http } = configure({});
    const api = http.extend({ prefixUrl: "https://api.example.com" });
    const user = await api.get("users/1").json(UserSchema);
    expect(user).toEqual({ id: "u1", name: "Alice" });

    const nested = api.extend({ timeout: 1000 });
    const again = await nested.post("users").json(UserSchema);
    expect(again).toEqual({ id: "u1", name: "Alice" });
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Nominal brands (the type-level guard has a runtime counterpart)
// ---------------------------------------------------------------------------

test("the configured client and its response promises carry the runtime brands", async () => {
  const cleanup = installRuntime({ id: "u1", name: "Alice" });
  try {
    const { http } = configure({});
    expect((http as unknown as Record<PropertyKey, unknown>)[CONFIGURED_HTTP_CLIENT]).toBe(true);

    const extended = http.extend({ prefixUrl: "https://api.example.com" });
    expect((extended as unknown as Record<PropertyKey, unknown>)[CONFIGURED_HTTP_CLIENT]).toBe(
      true,
    );

    const promise = http.get("users/1");
    expect((promise as unknown as Record<PropertyKey, unknown>)[SCHEMA_JSON_ATTACHED]).toBe(true);
    const tracked = promise.track("GET /users/:id");
    expect((tracked as unknown as Record<PropertyKey, unknown>)[SCHEMA_JSON_ATTACHED]).toBe(true);
    await promise;
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// parseWithSchema unit behaviour
// ---------------------------------------------------------------------------

test("parseWithSchema prefers parse so the schema's own error propagates", () => {
  const zodError = (() => {
    try {
      parseWithSchema({ id: 1 }, UserSchema);
      return null;
    } catch (err) {
      return err;
    }
  })();
  expect(zodError).toBeInstanceOf(z.ZodError);
});

test("parseWithSchema survives a symbol segment in an issue path", () => {
  const symbolKey = Symbol("secret");
  const symbolPath: SchemaLike<unknown> = {
    safeParse() {
      return {
        success: false as const,
        // `Array#join` throws a TypeError on a symbol segment; the summary must
        // stringify each segment instead of blowing up the caller's error.
        error: { issues: [{ message: "Expected string", path: [symbolKey] }] },
      };
    },
  };
  expect(() => parseWithSchema({}, symbolPath)).toThrow(
    /Symbol\(secret\): Expected string/,
  );
});

test("parseWithSchema summarizes at most 3 issues for a safeParse-only schema", () => {
  const many: SchemaLike<unknown> = {
    safeParse() {
      return {
        success: false as const,
        error: {
          issues: [
            { message: "m1", path: ["a"] },
            { message: "m2", path: ["b"] },
            { message: "m3", path: ["c"] },
            { message: "m4", path: ["d"] },
          ],
        },
      };
    },
  };
  expect(() => parseWithSchema({}, many)).toThrow(
    /a: m1; b: m2; c: m3 \(\+1 more\)/,
  );
});
