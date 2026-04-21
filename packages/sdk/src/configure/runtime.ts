/**
 * @module configure/runtime
 *
 * Runtime accessor helpers used by all configure lazy builders.
 * Wraps the carrier's optional getRuntime() with a throw-on-missing contract.
 */

import {
  getRuntime as getCarrierRuntime,
  type InternalRuntime,
} from "../runtime-carrier.js";

export type { InternalRuntime };

/**
 * Get the current runtime context, throwing if accessed outside test execution.
 * @internal
 */
export function getRuntime(): InternalRuntime {
  const runtime = getCarrierRuntime();
  if (!runtime) {
    throw new Error(
      "configure() values can only be accessed during test execution. " +
        "Did you try to read a var or secret at module load time? " +
        "Move the access inside a test function.",
    );
  }
  return runtime;
}

/**
 * Require a var from the runtime context. Throws if missing or empty.
 * @internal
 */
export function requireVar(key: string): string {
  const runtime = getRuntime();
  const value = runtime.vars[key];
  if (value === undefined || value === null || value === "") {
    throw new Error(`Missing required var: ${key}`);
  }
  return value;
}

/**
 * Require a secret from the runtime context. Throws if missing or empty.
 * @internal
 */
export function requireSecret(key: string): string {
  const runtime = getRuntime();
  const value = runtime.secrets[key];
  if (value === undefined || value === null || value === "") {
    throw new Error(`Missing required secret: ${key}`);
  }
  return value;
}
