/**
 * Type-level tests for `ctx.validate` severity narrowing (issue #30).
 *
 * The runtime aborts on `severity: "fatal"` (runner harness + engine both emit
 * the failed assertion and then throw), so the call only ever RETURNS on
 * success. These probes pin that truth into the type system:
 *
 *   - `ctx.validate(data, schema, label, { severity: "fatal" })` → exactly `T`
 *   - every other form (default / "error" / "warn" / widened severity)
 *     → exactly `T | undefined`
 *
 * No runtime assertions. Only type correctness. Runs via `tsc --noEmit`.
 *
 * @see packages/runner/src/executor.test.ts "ctx.validate - fatal severity aborts test"
 * @see packages/runner/src/harness.ts runSchemaValidation (case "fatal" → throw)
 */

/* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/no-unused-expressions */

import type { SchemaLike, TestContext, ValidateOptions } from "./types.js";

// Invariant (both-ways) type equality — `A extends B` alone would accept
// `T` vs `T | undefined` in one direction, which is exactly the bug under test.
type Exact<A, B> =
  (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2 ? true : false;

interface User {
  id: string;
  name: string;
}

// Type-only fixtures (never executed).
declare const ctx: TestContext;
declare const body: unknown;
declare const UserSchema: SchemaLike<User>;

// ---------------------------------------------------------------------------
// Test 1: `severity: "fatal"` narrows to exactly T (no `| undefined`)
// ---------------------------------------------------------------------------

const fatalUser = ctx.validate(body, UserSchema, "response body", { severity: "fatal" });
const _fatalIsExactlyUser: Exact<typeof fatalUser, User> = true;
const _fatalIsNotOptional: Exact<typeof fatalUser, User | undefined> = false;
void _fatalIsExactlyUser;
void _fatalIsNotOptional;

// The narrowed value is usable without `!` / `as User` ceremony.
const _fatalId: string = fatalUser.id;
void _fatalId;

// `label` may be omitted by passing `undefined` (a required parameter can't
// follow an optional one in an overload).
const fatalNoLabel = ctx.validate(body, UserSchema, undefined, { severity: "fatal" });
const _fatalNoLabelIsExactlyUser: Exact<typeof fatalNoLabel, User> = true;
void _fatalNoLabelIsExactlyUser;

// Extra options alongside `severity: "fatal"` still select the narrow overload.
const fatalWithExtras = ctx.validate(body, UserSchema, "response body", {
  severity: "fatal",
} satisfies ValidateOptions & { severity: "fatal" });
const _fatalWithExtrasIsExactlyUser: Exact<typeof fatalWithExtras, User> = true;
void _fatalWithExtrasIsExactlyUser;

// ---------------------------------------------------------------------------
// Test 2: every non-fatal form stays exactly T | undefined
// ---------------------------------------------------------------------------

const defaultUser = ctx.validate(body, UserSchema, "response body");
const _defaultIsOptional: Exact<typeof defaultUser, User | undefined> = true;
const _defaultIsNotNarrowed: Exact<typeof defaultUser, User> = false;
void _defaultIsOptional;
void _defaultIsNotNarrowed;

const errorUser = ctx.validate(body, UserSchema, "response body", { severity: "error" });
const _errorIsOptional: Exact<typeof errorUser, User | undefined> = true;
void _errorIsOptional;

const warnUser = ctx.validate(body, UserSchema, "response body", { severity: "warn" });
const _warnIsOptional: Exact<typeof warnUser, User | undefined> = true;
void _warnIsOptional;

const noOptionsUser = ctx.validate(body, UserSchema);
const _noOptionsIsOptional: Exact<typeof noOptionsUser, User | undefined> = true;
void _noOptionsIsOptional;

// A severity the compiler can't pin to the literal "fatal" must NOT narrow —
// the runtime may or may not abort, so `undefined` stays in the return type.
declare const dynamicOptions: ValidateOptions;
const dynamicUser = ctx.validate(body, UserSchema, "response body", dynamicOptions);
const _dynamicIsOptional: Exact<typeof dynamicUser, User | undefined> = true;
void _dynamicIsOptional;

declare const maybeFatalOptions: { severity: "fatal" | "warn" };
const maybeFatalUser = ctx.validate(body, UserSchema, "response body", maybeFatalOptions);
const _maybeFatalIsOptional: Exact<typeof maybeFatalUser, User | undefined> = true;
void _maybeFatalIsOptional;
