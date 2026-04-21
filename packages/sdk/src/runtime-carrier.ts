/**
 * RuntimeCarrier — internal abstraction over how the SDK reaches the current
 * per-test runtime context (vars / secrets / session / http / trace hooks).
 *
 * **Public API is zero-change.** All user-facing surfaces (`ctx.http`,
 * `ctx.vars`, `ctx.secrets`, `ctx.session`) continue to work exactly as
 * before.
 *
 * ## Default impl
 *
 * {@link createAlsCarrier} — `AsyncLocalStorage`-backed with a closure-level
 * module slot fallback. Concurrent `runWithRuntime()` callers are isolated
 * (each sees their own runtime across async boundaries). All first-party
 * packages (`runner` harness, `browser` plugin) read/write the carrier via
 * `@glubean/sdk/internal`, never through `globalThis`.
 *
 * ## Retained alternate: {@link createGlobalThisCarrier}
 *
 * Historical R1 impl backed by `globalThis.__glubeanRuntime`. Not the default
 * any longer — kept in source as a revert target and test fixture. Can be
 * reinstalled via {@link installCarrier} if an ALS regression ever needs a
 * one-line rollback.
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

import { AsyncLocalStorage } from "node:async_hooks";
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
 * - {@link createAlsCarrier} — current default. Concurrent isolation via
 *   AsyncLocalStorage.
 * - {@link createGlobalThisCarrier} — retained revert target.
 *
 * @internal
 */
export interface RuntimeCarrier {
  get(): InternalRuntime | undefined;
  set(rt: InternalRuntime | undefined): void;
  /**
   * Run `fn` with `rt` as the active runtime, restoring the previous value
   * afterwards.
   *
   * **Async contract:** if `fn()` returns a `Promise`, the previous runtime
   * is restored only after that Promise settles (resolve or reject). Code
   * after `await` points inside `fn` therefore observes `rt`, not the
   * restored value.
   *
   * **Concurrency:**
   * - ALS impl (default): true isolation — concurrent `runWith()` callers
   *   each see their own `rt` via AsyncLocalStorage across all async
   *   boundaries.
   * - globalThis impl: single shared slot — two *concurrent* `runWith()`
   *   calls race the slot. Sequential / single-in-flight safe.
   */
  runWith<T>(rt: InternalRuntime, fn: () => T): T;
}

const GLOBAL_SLOT = "__glubeanRuntime";

/**
 * globalThis-backed carrier. **Not the default** — retained in source as a
 * revert target and test fixture. Uses `globalThis.__glubeanRuntime` as the
 * single shared slot.
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

/**
 * Default carrier: AsyncLocalStorage-backed with a closure module slot.
 *
 * Storage:
 * - **ALS store** — authoritative for code running inside a
 *   {@link RuntimeCarrier.runWith} scope. Propagates across all async
 *   boundaries. Concurrent callers are fully isolated.
 * - **Module slot** — closure-scoped variable set by {@link RuntimeCarrier.set}
 *   for code running outside any `runWith()` scope (e.g. harness code after
 *   a subprocess-level `setRuntime()` but before any `runWith()` wrap).
 *
 * `get()` reads ALS first, falls back to the module slot. No `globalThis`
 * access — external plugins must migrate to `@glubean/sdk/internal.getRuntime`.
 *
 * @internal
 */
export function createAlsCarrier(): RuntimeCarrier {
  const als = new AsyncLocalStorage<InternalRuntime>();
  let moduleSlot: InternalRuntime | undefined;
  return {
    get() {
      return als.getStore() ?? moduleSlot;
    },
    set(rt) {
      moduleSlot = rt;
    },
    runWith(rt, fn) {
      // ALS natively propagates `rt` across await boundaries — no manual
      // save/restore of the module slot is needed. `als.run(rt, fn)` binds
      // `rt` for the duration of `fn`'s continuation chain and unbinds
      // automatically when the returned promise settles.
      return als.run(rt, fn);
    },
  };
}

let _carrier: RuntimeCarrier = createAlsCarrier();

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
