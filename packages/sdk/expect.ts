/**
 * Fluent assertion API for Glubean tests.
 *
 * Inspired by Jest/Vitest `expect()` but designed for API testing:
 * - **Soft-by-default**: Failed assertions emit events but do NOT throw.
 *   All assertions run and all failures are collected.
 * - **`.orFail()` guard**: Opt-in hard failure for when subsequent code
 *   depends on the assertion passing.
 * - **`.not` negation**: Negate any assertion via a getter.
 *
 * The class is framework-agnostic — it accepts an `emitter` callback
 * that routes assertion results into the runner's event pipeline.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The result emitted for every assertion.
 * This is the payload passed to the emitter callback.
 */
export interface AssertionEmission {
  passed: boolean;
  message: string;
  actual?: unknown;
  expected?: unknown;
}

/**
 * Callback that routes an assertion result into the runner's event system.
 * In the harness this maps to `ctx.assert(result)`.
 */
export type AssertEmitter = (result: AssertionEmission) => void;

/**
 * Result returned by a custom matcher function.
 * The SDK handles `.not` negation and `.orFail()` automatically based on `passed`.
 */
export interface MatcherResult {
  /** Whether the assertion passed. */
  passed: boolean;
  /** Human-readable message describing the assertion (used in reports). */
  message: string;
  /** The actual value (for assertion reports). */
  actual?: unknown;
  /** The expected value (for assertion reports). */
  expected?: unknown;
}

/**
 * A custom matcher function for `Expectation.extend()`.
 * Receives the actual value and any extra arguments passed by the user.
 *
 * @example
 * ```ts
 * const toBeEven: MatcherFn = (actual) => ({
 *   passed: typeof actual === "number" && actual % 2 === 0,
 *   message: `to be even`,
 *   actual,
 * });
 * ```
 */
export type MatcherFn = (actual: unknown, ...args: unknown[]) => MatcherResult;

/**
 * Interface for user-defined custom assertion matchers.
 *
 * Augment this interface via TypeScript **declaration merging** to get
 * type-safe access to matchers registered with `Expectation.extend()`.
 * The SDK merges `CustomMatchers` into the `Expectation` class type, so
 * custom matchers automatically appear on every `ctx.expect()` call.
 *
 * **Important**: Call `Expectation.extend(matchers)` at the top of your test
 * file to register the runtime implementation. The declaration merging below
 * only provides type information.
 *
 * @example
 * ```ts
 * // 1. Declare the types (in your test file or a shared .d.ts):
 * declare module "@glubean/sdk/expect" {
 *   interface CustomMatchers<T> {
 *     toBeEven(): Expectation<T>;
 *     toBeWithinRange(min: number, max: number): Expectation<T>;
 *   }
 * }
 *
 * // 2. Register the runtime implementations:
 * import { Expectation } from "@glubean/sdk/expect";
 *
 * Expectation.extend({
 *   toBeEven: (actual) => ({
 *     passed: typeof actual === "number" && actual % 2 === 0,
 *     message: "to be even",
 *     actual,
 *   }),
 *   toBeWithinRange: (actual, min, max) => ({
 *     passed: typeof actual === "number"
 *       && actual >= (min as number) && actual <= (max as number),
 *     message: `to be within [${min}, ${max}]`,
 *     actual,
 *     expected: `[${min}, ${max}]`,
 *   }),
 * });
 *
 * // 3. Use — fully typed, no `as any` needed:
 * ctx.expect(4).toBeEven();             // ✅ typed
 * ctx.expect(5).not.toBeEven();         // ✅ negation
 * ctx.expect(50).toBeWithinRange(0, 100).orFail(); // ✅ chaining
 * ```
 *
 * @template T The type of the actual value being asserted on
 */
// deno-lint-ignore no-empty-interface
export interface CustomMatchers<T = unknown> {}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Produce a short, human-readable representation of a value for error messages.
 * Truncates long output to keep assertion messages scannable.
 */
export function inspect(value: unknown, maxLen = 64): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") {
    const escaped = JSON.stringify(value);
    if (escaped.length <= maxLen) return escaped;
    // Truncate: keep opening quote, trim content, append ..."
    // Result: "aaa..." which is maxLen chars total
    return escaped.slice(0, maxLen - 4) + '..."';
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "function") {
    return `[Function: ${value.name || "anonymous"}]`;
  }
  if (value instanceof RegExp) return value.toString();
  if (value instanceof Date) return value.toISOString();
  try {
    const json = JSON.stringify(value);
    return json.length > maxLen ? json.slice(0, maxLen - 3) + "..." : json;
  } catch {
    return String(value);
  }
}

/**
 * Deep equality check.
 * Handles primitives, arrays, plain objects, Date, RegExp, Map, Set, null, undefined.
 * Safely handles circular references via a seen-pairs set.
 */
export function deepEqual(a: unknown, b: unknown, seen?: Set<object>): boolean {
  if (Object.is(a, b)) return true;

  if (
    a === null ||
    b === null ||
    typeof a !== "object" ||
    typeof b !== "object"
  ) {
    return false;
  }

  // Circular reference guard: if we've already started comparing this exact
  // pair of object references, treat them as equal to avoid infinite recursion.
  if (!seen) seen = new Set();
  const sentinel = { a, b } as unknown as object;
  for (const s of seen) {
    const pair = s as unknown as { a: unknown; b: unknown };
    if (pair.a === a && pair.b === b) return true;
  }
  seen.add(sentinel);

  // Date
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  // RegExp
  if (a instanceof RegExp && b instanceof RegExp) {
    return a.source === b.source && a.flags === b.flags;
  }
  // Map
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [key, val] of a) {
      if (!b.has(key) || !deepEqual(val, b.get(key), seen)) return false;
    }
    return true;
  }
  // Set
  if (a instanceof Set && b instanceof Set) {
    if (a.size !== b.size) return false;
    for (const val of a) {
      if (!b.has(val)) return false;
    }
    return true;
  }
  // Array
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i], seen)) return false;
    }
    return true;
  }
  // Plain objects
  const keysA = Object.keys(a as Record<string, unknown>);
  const keysB = Object.keys(b as Record<string, unknown>);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (
      !Object.prototype.hasOwnProperty.call(b, key) ||
      !deepEqual(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
        seen,
      )
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Check whether `subset` is a subset-match of `obj` (partial deep equality).
 * Every key in `subset` must exist in `obj` and deeply equal the value.
 */
function matchesObject(
  obj: Record<string, unknown>,
  subset: Record<string, unknown>,
): boolean {
  for (const key of Object.keys(subset)) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) return false;
    const sv = subset[key];
    const ov = obj[key];
    if (
      typeof sv === "object" &&
      sv !== null &&
      !Array.isArray(sv) &&
      typeof ov === "object" &&
      ov !== null &&
      !Array.isArray(ov)
    ) {
      if (
        !matchesObject(
          ov as Record<string, unknown>,
          sv as Record<string, unknown>,
        )
      ) {
        return false;
      }
    } else if (!deepEqual(ov, sv)) {
      return false;
    }
  }
  return true;
}

/**
 * Resolve a dot-separated property path on an object.
 * Returns `{ found: true, value }` or `{ found: false }`.
 */
function resolvePath(
  obj: unknown,
  path: string,
): { found: boolean; value?: unknown } {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (
      current === null ||
      current === undefined ||
      typeof current !== "object"
    ) {
      return { found: false };
    }
    if (!Object.prototype.hasOwnProperty.call(current, part)) {
      return { found: false };
    }
    current = (current as Record<string, unknown>)[part];
  }
  return { found: true, value: current };
}

// ---------------------------------------------------------------------------
// Sentinel error for .orFail()
// ---------------------------------------------------------------------------

/**
 * Error thrown by `.orFail()` when the preceding assertion failed.
 * Caught by the harness as a hard failure.
 */
export class ExpectFailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpectFailError";
  }
}

// ---------------------------------------------------------------------------
// Expectation class
// ---------------------------------------------------------------------------

/**
 * Merges `CustomMatchers` into the `Expectation` class type.
 * This enables declaration merging: when users augment `CustomMatchers<T>`,
 * the additional methods automatically appear on `Expectation<T>` instances.
 */
export interface Expectation<T> extends CustomMatchers<T> {}

/**
 * Fluent assertion object returned by `ctx.expect(actual)`.
 *
 * Every terminal method (e.g. `toBe`, `toContain`) emits an assertion event
 * and returns `this` for optional chaining with `.orFail()`.
 *
 * **Soft-by-default**: failed assertions are recorded but execution continues.
 *
 * **Custom matchers**: Use `Expectation.extend()` to add domain-specific
 * assertions. Combine with `CustomMatchers` declaration merging for full
 * type safety — see {@link CustomMatchers} for details.
 *
 * @example
 * ```ts
 * ctx.expect(res.status).toBe(200);
 * ctx.expect(body.users).toHaveLength(3);
 * ctx.expect(body).toMatchObject({ success: true });
 * ctx.expect(res.status).toBe(200).orFail(); // hard guard
 * ctx.expect(body.banned).not.toBe(true);
 * ```
 */
export class Expectation<T> {
  /**
   * The actual value being asserted on.
   * `protected` (not `#private`) so that `Expectation.extend()` prototype
   * patching can access it at runtime.
   */
  protected _actual: T;
  private _negated: boolean;
  private _emit: AssertEmitter;
  /** Tracks whether the last assertion in this chain passed. */
  private _lastPassed = true;
  private _lastMessage = "";

  constructor(actual: T, emit: AssertEmitter, negated = false) {
    this._actual = actual;
    this._emit = emit;
    this._negated = negated;
  }

  // -------------------------------------------------------------------------
  // Modifiers
  // -------------------------------------------------------------------------

  /**
   * Negate the next assertion.
   *
   * @example
   * ctx.expect(body.banned).not.toBe(true);
   * ctx.expect(body.roles).not.toContain("superadmin");
   */
  get not(): Expectation<T> {
    return new Expectation(this._actual, this._emit, !this._negated);
  }

  /**
   * If the preceding assertion failed, throw immediately to abort the test.
   * Use this for "guard" assertions where subsequent code depends on the value.
   *
   * @example
   * ctx.expect(res.status).toBe(200).orFail();
   * const body = await res.json(); // safe — status was 200
   */
  orFail(): this {
    if (!this._lastPassed) {
      throw new ExpectFailError(this._lastMessage);
    }
    return this;
  }

  // -------------------------------------------------------------------------
  // Custom matchers
  // -------------------------------------------------------------------------

  /**
   * Register custom assertion matchers on the `Expectation` prototype.
   *
   * Each matcher is a pure function that receives the actual value and any
   * extra arguments, and returns a `MatcherResult`. The SDK automatically
   * handles `.not` negation and `.orFail()` chaining.
   *
   * **Isolation**: Each test file runs in its own Deno subprocess, so
   * prototype mutations from `Expectation.extend()` do not leak between files.
   *
   * **Type safety**: To get full TypeScript support for custom matchers,
   * augment the {@link CustomMatchers} interface via declaration merging.
   * See {@link CustomMatchers} for a complete example.
   *
   * @param matchers Record of matcher name → matcher function
   * @throws If a matcher name conflicts with an existing method
   *
   * @example
   * ```ts
   * // Step 1: Declare types (in your test file or shared .d.ts)
   * declare module "@glubean/sdk/expect" {
   *   interface CustomMatchers<T> {
   *     toBeEven(): Expectation<T>;
   *     toBeWithinRange(min: number, max: number): Expectation<T>;
   *   }
   * }
   *
   * // Step 2: Register runtime implementations
   * import { Expectation } from "@glubean/sdk/expect";
   *
   * Expectation.extend({
   *   toBeEven: (actual) => ({
   *     passed: typeof actual === "number" && actual % 2 === 0,
   *     message: "to be even",
   *     actual,
   *   }),
   *   toBeWithinRange: (actual, min, max) => ({
   *     passed: typeof actual === "number" && actual >= (min as number) && actual <= (max as number),
   *     message: `to be within [${min}, ${max}]`,
   *     actual,
   *     expected: `[${min}, ${max}]`,
   *   }),
   * });
   *
   * // Step 3: Use — fully typed
   * ctx.expect(count).toBeEven();
   * ctx.expect(count).not.toBeEven();
   * ctx.expect(score).toBeWithinRange(0, 100).orFail();
   * ```
   */
  static extend(matchers: Record<string, MatcherFn>): void {
    for (const [name, fn] of Object.entries(matchers)) {
      if (name in Expectation.prototype) {
        throw new Error(
          `Matcher "${name}" already exists on Expectation. ` +
            `Choose a different name to avoid conflicts with built-in matchers.`,
        );
      }
      // deno-lint-ignore no-explicit-any
      (Expectation.prototype as any)[name] = function (
        this: Expectation<unknown>,
        ...args: unknown[]
      ): Expectation<unknown> {
        // Access protected members via the instance.
        // deno-lint-ignore no-explicit-any
        const self = this as any;
        const result: MatcherResult = fn(self._actual, ...args);
        return self._report(
          result.passed,
          result.message,
          result.actual,
          result.expected,
        );
      };
    }
  }

  // -------------------------------------------------------------------------
  // Internal emit helper
  // -------------------------------------------------------------------------

  /**
   * Emit an assertion result.
   * `protected` so that `Expectation.extend()` prototype patching can call it.
   */
  protected _report(
    rawPassed: boolean,
    message: string,
    actual?: unknown,
    expected?: unknown,
  ): this {
    const passed = this._negated ? !rawPassed : rawPassed;
    const prefix = this._negated ? "not " : "";
    const fullMessage = passed
      ? `expected ${inspect(this._actual)} ${prefix}${message}`
      : `expected ${inspect(this._actual)} ${prefix}${message}`;
    this._lastPassed = passed;
    this._lastMessage = fullMessage;
    this._emit({ passed, message: fullMessage, actual, expected });
    return this;
  }

  // -------------------------------------------------------------------------
  // Equality
  // -------------------------------------------------------------------------

  /**
   * Strict equality (`Object.is`).
   *
   * @example ctx.expect(res.status).toBe(200);
   */
  toBe(expected: T): this {
    return this._report(
      Object.is(this._actual, expected),
      `to be ${inspect(expected)}`,
      this._actual,
      expected,
    );
  }

  /**
   * Deep equality.
   *
   * @example ctx.expect(body).toEqual({ id: 1, name: "Alice" });
   */
  toEqual(expected: T): this {
    return this._report(
      deepEqual(this._actual, expected),
      `to equal ${inspect(expected)}`,
      this._actual,
      expected,
    );
  }

  // -------------------------------------------------------------------------
  // Type / truthiness
  // -------------------------------------------------------------------------

  /**
   * Check the runtime type via `typeof`.
   *
   * @example ctx.expect(body.name).toBeType("string");
   */
  toBeType(
    expected:
      | "string"
      | "number"
      | "boolean"
      | "object"
      | "undefined"
      | "function"
      | "bigint"
      | "symbol",
  ): this {
    const actualType = typeof this._actual;
    return this._report(
      actualType === expected,
      `to be type ${inspect(expected)}`,
      actualType,
      expected,
    );
  }

  /**
   * Check that the value is truthy.
   *
   * @example ctx.expect(body.active).toBeTruthy();
   */
  toBeTruthy(): this {
    return this._report(!!this._actual, "to be truthy", this._actual);
  }

  /**
   * Check that the value is falsy.
   *
   * @example ctx.expect(body.deleted).toBeFalsy();
   */
  toBeFalsy(): this {
    return this._report(!this._actual, "to be falsy", this._actual);
  }

  /**
   * Check that the value is `null`.
   *
   * @example ctx.expect(body.avatar).toBeNull();
   */
  toBeNull(): this {
    return this._report(
      this._actual === null,
      "to be null",
      this._actual,
      null,
    );
  }

  /**
   * Check that the value is `undefined`.
   *
   * @example ctx.expect(body.nickname).toBeUndefined();
   */
  toBeUndefined(): this {
    return this._report(
      this._actual === undefined,
      "to be undefined",
      this._actual,
      undefined,
    );
  }

  /**
   * Check that the value is not `undefined`.
   *
   * @example ctx.expect(body.id).toBeDefined();
   */
  toBeDefined(): this {
    return this._report(
      this._actual !== undefined,
      "to be defined",
      this._actual,
    );
  }

  // -------------------------------------------------------------------------
  // Numeric comparisons
  // -------------------------------------------------------------------------

  /**
   * Check that the value is greater than `n`.
   *
   * @example ctx.expect(body.age).toBeGreaterThan(0);
   */
  toBeGreaterThan(n: number): this {
    return this._report(
      (this._actual as unknown as number) > n,
      `to be greater than ${n}`,
      this._actual,
      `> ${n}`,
    );
  }

  /**
   * Check that the value is greater than or equal to `n`.
   *
   * @example ctx.expect(body.items.length).toBeGreaterThanOrEqual(1);
   */
  toBeGreaterThanOrEqual(n: number): this {
    return this._report(
      (this._actual as unknown as number) >= n,
      `to be greater than or equal to ${n}`,
      this._actual,
      `>= ${n}`,
    );
  }

  /**
   * Check that the value is less than `n`.
   *
   * @example ctx.expect(body.age).toBeLessThan(200);
   */
  toBeLessThan(n: number): this {
    return this._report(
      (this._actual as unknown as number) < n,
      `to be less than ${n}`,
      this._actual,
      `< ${n}`,
    );
  }

  /**
   * Check that the value is less than or equal to `n`.
   *
   * @example ctx.expect(res.status).toBeLessThanOrEqual(299);
   */
  toBeLessThanOrEqual(n: number): this {
    return this._report(
      (this._actual as unknown as number) <= n,
      `to be less than or equal to ${n}`,
      this._actual,
      `<= ${n}`,
    );
  }

  /**
   * Check that the value is within `[min, max]` (inclusive).
   *
   * @example ctx.expect(body.score).toBeWithin(0, 100);
   */
  toBeWithin(min: number, max: number): this {
    const val = this._actual as unknown as number;
    return this._report(
      val >= min && val <= max,
      `to be within [${min}, ${max}]`,
      this._actual,
      `[${min}, ${max}]`,
    );
  }

  // -------------------------------------------------------------------------
  // Collection / string
  // -------------------------------------------------------------------------

  /**
   * Check that the value has the expected `length`.
   *
   * @example ctx.expect(body.users).toHaveLength(3);
   */
  toHaveLength(expected: number): this {
    const actual = (this._actual as unknown as { length: number })?.length;
    return this._report(
      actual === expected,
      `to have length ${expected}`,
      actual,
      expected,
    );
  }

  /**
   * Check that an array or string contains the given item/substring.
   *
   * @example
   * ctx.expect(body.roles).toContain("admin");
   * ctx.expect(body.name).toContain("Ali");
   */
  toContain(item: unknown): this {
    let found: boolean;
    if (Array.isArray(this._actual)) {
      found = this._actual.some((el) => deepEqual(el, item));
    } else if (typeof this._actual === "string") {
      found = this._actual.includes(item as string);
    } else {
      found = false;
    }
    return this._report(
      found,
      `to contain ${inspect(item)}`,
      this._actual,
      item,
    );
  }

  /**
   * Check that a string matches a regex or includes a substring.
   *
   * @example
   * ctx.expect(body.email).toMatch(/@example\.com$/);
   * ctx.expect(body.name).toMatch("Alice");
   */
  toMatch(pattern: RegExp | string): this {
    const actual = this._actual as unknown as string;
    const passed = pattern instanceof RegExp ? pattern.test(actual) : actual?.includes(pattern);
    return this._report(
      !!passed,
      `to match ${inspect(pattern)}`,
      this._actual,
      pattern instanceof RegExp ? pattern.toString() : pattern,
    );
  }

  /**
   * Check that a string starts with the given prefix.
   *
   * @example
   * ctx.expect(body.id).toStartWith("usr_");
   * ctx.expect(url).toStartWith("https://");
   */
  toStartWith(prefix: string): this {
    const actual = this._actual as unknown as string;
    return this._report(
      typeof actual === "string" && actual.startsWith(prefix),
      `to start with ${inspect(prefix)}`,
      this._actual,
      prefix,
    );
  }

  /**
   * Check that a string ends with the given suffix.
   *
   * @example
   * ctx.expect(body.email).toEndWith("@example.com");
   * ctx.expect(body.filename).toEndWith(".json");
   */
  toEndWith(suffix: string): this {
    const actual = this._actual as unknown as string;
    return this._report(
      typeof actual === "string" && actual.endsWith(suffix),
      `to end with ${inspect(suffix)}`,
      this._actual,
      suffix,
    );
  }

  /**
   * Partial deep match — every key in `subset` must exist and match in the actual value.
   *
   * @example ctx.expect(body).toMatchObject({ success: true, data: { id: 1 } });
   */
  toMatchObject(subset: Record<string, unknown>): this {
    const passed = typeof this._actual === "object" &&
      this._actual !== null &&
      matchesObject(this._actual as Record<string, unknown>, subset);
    return this._report(
      !!passed,
      `to match object ${inspect(subset)}`,
      this._actual,
      subset,
    );
  }

  /**
   * Check that the value has a property at the given path.
   * Optionally check the property value.
   *
   * @example
   * ctx.expect(body).toHaveProperty("id");
   * ctx.expect(body).toHaveProperty("meta.created", "2024-01-01");
   */
  toHaveProperty(path: string, value?: unknown): this {
    const resolved = resolvePath(this._actual, path);
    let passed = resolved.found;
    if (passed && arguments.length >= 2) {
      passed = deepEqual(resolved.value, value);
    }
    const msg = arguments.length >= 2
      ? `to have property "${path}" with value ${inspect(value)}`
      : `to have property "${path}"`;
    return this._report(
      passed,
      msg,
      arguments.length >= 2 ? resolved.value : resolved.found,
      arguments.length >= 2 ? value : true,
    );
  }

  /**
   * Check that the value has all of the given property keys.
   * Reports all missing keys in a single assertion message.
   *
   * @example
   * ctx.expect(body).toHaveProperties(["id", "name", "email", "createdAt"]);
   */
  toHaveProperties(keys: string[]): this {
    const missing: string[] = [];
    for (const key of keys) {
      const resolved = resolvePath(this._actual, key);
      if (!resolved.found) {
        missing.push(key);
      }
    }
    const passed = missing.length === 0;
    const msg = passed
      ? `to have properties [${keys.join(", ")}]`
      : `to have properties [${keys.join(", ")}] — missing: [${missing.join(", ")}]`;
    return this._report(passed, msg, missing, []);
  }

  /**
   * Custom predicate assertion.
   *
   * @example ctx.expect(body).toSatisfy((b) => b.items.length > 0, "should have items");
   */
  toSatisfy(predicate: (actual: T) => boolean, label?: string): this {
    let passed: boolean;
    try {
      passed = predicate(this._actual);
    } catch {
      passed = false;
    }
    const desc = label || "to satisfy predicate";
    return this._report(passed, desc, this._actual);
  }

  // -------------------------------------------------------------------------
  // HTTP-specific helpers
  // -------------------------------------------------------------------------

  /**
   * Assert on the `status` property (typically a `Response` object).
   *
   * @example ctx.expect(res).toHaveStatus(200);
   */
  toHaveStatus(code: number): this {
    const actual = (this._actual as unknown as { status: number })?.status;
    return this._report(
      actual === code,
      `to have status ${code}`,
      actual,
      code,
    );
  }

  /**
   * Assert that a Response-like object has a JSON body matching the given subset
   * (partial deep match, like `toMatchObject`).
   *
   * This method is **async** because it calls `.json()` on the response.
   *
   * @example
   * await ctx.expect(res).toHaveJsonBody({ success: true, data: { id: 1 } });
   * (await ctx.expect(res).toHaveJsonBody({ ok: true })).orFail();
   */
  async toHaveJsonBody(subset: Record<string, unknown>): Promise<this> {
    const actual = this._actual as unknown as
      | { json(): Promise<unknown> }
      | null
      | undefined;

    if (!actual || typeof actual.json !== "function") {
      return this._report(
        false,
        `to have JSON body matching ${inspect(subset)} — actual is not a Response`,
        this._actual,
        subset,
      );
    }

    let body: unknown;
    try {
      body = await actual.json();
    } catch {
      return this._report(
        false,
        `to have JSON body matching ${inspect(subset)} — failed to parse JSON`,
        this._actual,
        subset,
      );
    }

    const passed = typeof body === "object" &&
      body !== null &&
      matchesObject(body as Record<string, unknown>, subset);

    return this._report(
      !!passed,
      `to have JSON body matching ${inspect(subset)}`,
      body,
      subset,
    );
  }

  /**
   * Assert that a `Response` or headers-like object has a specific header.
   * Optionally check the header value against a string or regex.
   *
   * @example
   * ctx.expect(res).toHaveHeader("content-type");
   * ctx.expect(res).toHaveHeader("content-type", /json/);
   * ctx.expect(res).toHaveHeader("x-request-id", "abc123");
   */
  toHaveHeader(name: string, value?: string | RegExp): this {
    // Support both Response objects and plain header maps
    let headerValue: string | null | undefined;
    const actual = this._actual as unknown as
      | { headers: Headers | Record<string, string> }
      | null
      | undefined;

    if (actual?.headers) {
      if (typeof (actual.headers as Headers).get === "function") {
        headerValue = (actual.headers as Headers).get(name);
      } else {
        // Plain object lookup (case-sensitive)
        headerValue = (actual.headers as Record<string, string>)[name] ??
          (actual.headers as Record<string, string>)[name.toLowerCase()];
      }
    }

    let passed: boolean;
    if (value === undefined) {
      // Just check existence
      passed = headerValue !== null && headerValue !== undefined;
    } else if (value instanceof RegExp) {
      passed = headerValue != null && value.test(headerValue);
    } else {
      passed = headerValue === value;
    }

    const expectedDesc = value === undefined
      ? `to have header "${name}"`
      : `to have header "${name}" matching ${inspect(value)}`;

    return this._report(
      passed,
      expectedDesc,
      headerValue,
      value ?? "(present)",
    );
  }
}
