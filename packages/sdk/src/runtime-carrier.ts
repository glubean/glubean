/**
 * RuntimeCarrier — internal abstraction over how the SDK reaches the current
 * per-test runtime context (vars / secrets / session / http / trace hooks).
 *
 * **Public API is zero-change.** All user-facing surfaces (`ctx.http`,
 * `ctx.vars`, `ctx.secrets`, `ctx.session`) continue to work exactly as
 * before. This module only refactors the *internal* wiring so that the
 * mechanism (globalThis today, AsyncLocalStorage tomorrow) is swappable.
 *
 * ## Rounds
 *
 * - **R1 (current):** default impl is `createGlobalThisCarrier()` — behavior
 *   is 1:1 equivalent to the old `globalThis.__glubeanRuntime` direct access.
 * - **R2 (future):** swap default impl to `createAlsCarrier()` backed by
 *   `AsyncLocalStorage`, unlocking concurrent runners in a single process.
 *   The interface and call sites do not change.
 *
 * ## Audience
 *
 * Exported via `@glubean/sdk/internal`. Consumed by:
 * - `@glubean/runner` (harness) — sets the runtime before user code runs.
 * - `@glubean/browser`, other first-party plugins — read test metadata.
 *
 * User test code must **not** import from this module.
 *
 * @internal
 */

import type {
  GlubeanAction,
  GlubeanEvent,
  GlubeanRuntime as PublicGlubeanRuntime,
  HttpClient,
  Trace,
} from "./types.js";

/**
 * Shape of the runtime context injected by the harness before test execution.
 *
 * This is the **internal** shape — the public `GlubeanRuntime` exported from
 * the top-level SDK adds helper methods (`requireVar`, `requireSecret`,
 * `resolveTemplate`) for plugin authors. The carrier transports this internal
 * shape; `configure()` augments it before handing to plugins.
 *
 * @internal
 */
export interface InternalRuntime {
  vars: Record<string, string>;
  secrets: Record<string, string>;
  /** Session key-value store. Set during session setup, available to all tests. */
  session: Record<string, unknown>;
  http: HttpClient;
  test?: PublicGlubeanRuntime["test"];
  trace?(t: Trace): void;
  action?(a: GlubeanAction): void;
  event?(ev: GlubeanEvent): void;
  log?(message: string, data?: unknown): void;
}

/**
 * Abstraction over where the current runtime lives.
 *
 * Implementations:
 * - {@link createGlobalThisCarrier} — R1 default, reads/writes
 *   `globalThis.__glubeanRuntime`. Behavior-equivalent to legacy direct access.
 * - Future ALS-backed carrier — R2, adds concurrent isolation.
 *
 * @internal
 */
export interface RuntimeCarrier {
  get(): InternalRuntime | undefined;
  set(rt: InternalRuntime | undefined): void;
  /**
   * Run `fn` with `rt` as the active runtime, restoring the previous value
   * afterwards. In R1 this swaps the globalThis slot; in R2 it runs inside
   * `AsyncLocalStorage.run()`.
   *
   * **Async contract:** if `fn()` returns a `Promise`, the previous runtime
   * is restored only after that Promise settles (resolve or reject). Code
   * after `await` points inside `fn` therefore observes `rt`, not the
   * restored value.
   *
   * **R1 concurrency caveat:** because R1's globalThis-backed slot is a
   * single shared cell, two *concurrent* `runWith()` calls will race on that
   * slot. Sequential or single-in-flight usage is safe in R1. True
   * concurrent isolation arrives with R2's AsyncLocalStorage impl.
   */
  runWith<T>(rt: InternalRuntime, fn: () => T): T;
}

const GLOBAL_SLOT = "__glubeanRuntime";

/**
 * R1 default: globalThis-backed carrier.
 *
 * Behavior is 1:1 equivalent to legacy direct reads/writes of
 * `globalThis.__glubeanRuntime`. Used both as the production default (until
 * R2) and as a permanent revert target if R2 introduces regressions.
 *
 * @internal
 */
export function createGlobalThisCarrier(): RuntimeCarrier {
  return {
    get() {
      return (globalThis as any)[GLOBAL_SLOT] as InternalRuntime | undefined;
    },
    set(rt) {
      (globalThis as any)[GLOBAL_SLOT] = rt;
    },
    runWith(rt, fn) {
      const prev = (globalThis as any)[GLOBAL_SLOT];
      (globalThis as any)[GLOBAL_SLOT] = rt;
      let result: unknown;
      try {
        result = fn();
      } catch (err) {
        (globalThis as any)[GLOBAL_SLOT] = prev;
        throw err;
      }
      // Async path: defer restore until the promise settles so that
      // continuations inside `fn` after `await` still observe `rt`.
      if (result !== null && typeof result === "object" && typeof (result as PromiseLike<unknown>).then === "function") {
        return (Promise.resolve(result as Promise<unknown>).finally(() => {
          (globalThis as any)[GLOBAL_SLOT] = prev;
        })) as ReturnType<typeof fn>;
      }
      // Sync path: restore immediately.
      (globalThis as any)[GLOBAL_SLOT] = prev;
      return result as ReturnType<typeof fn>;
    },
  };
}

let _carrier: RuntimeCarrier = createGlobalThisCarrier();

/**
 * Replace the active carrier. Used by tests and by the future R2 opt-in path.
 *
 * @internal
 */
export function installCarrier(c: RuntimeCarrier): void {
  _carrier = c;
}

/**
 * Read the current runtime context. Returns `undefined` when called outside
 * of test execution (e.g. at module load / scanner time). Callers that need
 * the throw-on-missing contract should wrap with their own `requireRuntime()`.
 *
 * @internal
 */
export function getRuntime(): InternalRuntime | undefined {
  return _carrier.get();
}

/**
 * Install a runtime into the carrier. The harness calls this once per test
 * subprocess before the user module is imported.
 *
 * @internal
 */
export function setRuntime(rt: InternalRuntime | undefined): void {
  _carrier.set(rt);
}

/**
 * Run `fn` with `rt` as the active runtime, restoring the previous value on
 * exit. In R1 this is a synchronous swap of the globalThis slot; in R2 it
 * becomes an ALS-scoped execution. Call sites do not change between rounds.
 *
 * @internal
 */
export function runWithRuntime<T>(rt: InternalRuntime, fn: () => T): T {
  return _carrier.runWith(rt, fn);
}
