/**
 * Type-level tests for the `configure()` HTTP client's schema-aware `.json()`
 * (issue #32).
 *
 * The capability only exists on the client `configure()` builds — `ctx.http` is
 * built by the runner/engine and its `.json(schema)` falls through to ky's
 * Standard-Schema path, which rejects a hand-rolled `SchemaLike`. Because the
 * no-arg `json<T>()` is STRUCTURALLY compatible with `json<T>(schema)`, the
 * distinction is carried by a nominal brand; these probes pin that a plain
 * client can NOT masquerade as the configured one.
 *
 * No runtime assertions (nothing here is executed). Runs via `tsc --noEmit`.
 */

/* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/no-unused-expressions */

import { configure } from "./configure.js";
import type {
  ConfiguredHttpClient,
  HttpClient,
  SchemaLike,
  TestContext,
  ValidatingHttpResponsePromise,
} from "./types.js";

type Exact<A, B> =
  (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2 ? true : false;

interface User {
  id: string;
  name: string;
}

declare const ctx: TestContext;
declare const plainClient: HttpClient;
declare const UserSchema: SchemaLike<User>;

const configured = configure({}).http;

// ---------------------------------------------------------------------------
// Test 1: the configured client IS the branded client, and still a plain one
// ---------------------------------------------------------------------------

const _configuredAssignable: ConfiguredHttpClient = configured;
const _configuredIsAlsoHttpClient: HttpClient = configured;
const _extendKeepsBrand: ConfiguredHttpClient = configured.extend({ timeout: 1000 });
void _configuredAssignable;
void _configuredIsAlsoHttpClient;
void _extendKeepsBrand;

// ---------------------------------------------------------------------------
// Test 2: a plain HttpClient can NOT masquerade as the configured client
// ---------------------------------------------------------------------------

// @ts-expect-error — ctx.http has no schema-aware json(); calling .json(schema)
// on it would fall into ky's Standard-Schema path and throw at run time.
const _ctxHttpIsNotConfigured: ConfiguredHttpClient = ctx.http;

// @ts-expect-error — same for any bare HttpClient (e.g. a hand-built mock).
const _plainIsNotConfigured: ConfiguredHttpClient = plainClient;

// ---------------------------------------------------------------------------
// Test 3: the response promise carries the same distinction
// ---------------------------------------------------------------------------

const _configuredPromise: ValidatingHttpResponsePromise = configured.get("users/1");
const _trackedPromise: ValidatingHttpResponsePromise = configured
  .get("users/1")
  .track("GET /users/:id");
void _configuredPromise;
void _trackedPromise;

// @ts-expect-error — a runner-built response promise has no schema form.
const _plainPromise: ValidatingHttpResponsePromise = ctx.http.get("users/1");

// ---------------------------------------------------------------------------
// Test 4: return types — schema form is exactly Promise<T>, no-arg unchanged
// ---------------------------------------------------------------------------

const validated = configured.get("users/1").json(UserSchema);
const _validatedIsExactlyUser: Exact<typeof validated, Promise<User>> = true;
void _validatedIsExactlyUser;

const rawBody = configured.get("users/1").json<unknown>();
const _rawIsUnknown: Exact<typeof rawBody, Promise<unknown>> = true;
void _rawIsUnknown;

const trackedValidated = configured.get("users/1").track("GET /users/:id").json(UserSchema);
const _trackedIsExactlyUser: Exact<typeof trackedValidated, Promise<User>> = true;
void _trackedIsExactlyUser;

// The plain surface is untouched: `ctx.http` still hands back `Promise<T>` from
// the no-arg form.
const ctxRaw = ctx.http.get("users/1").json<User>();
const _ctxRawIsUser: Exact<typeof ctxRaw, Promise<User>> = true;
void _ctxRawIsUser;
