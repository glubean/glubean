/**
 * @module runner-input-channel
 *
 * Process-local channel for runner-supplied case inputs. The dispatcher
 * (`contract-core.ts`) reads from this channel when applying the §5.1
 * runnable resolution algorithm. The runner harness writes to it before
 * importing the user module.
 *
 * Two independent slots per testId (per attachment-model §8):
 *
 * - `explicit input` — fed via CLI `--input-json` / MCP `inputJson` /
 *   programmatic `input`. When present, the dispatcher runs the raw case
 *   with this input AFTER validating against the case's `needs` schema
 *   (§5.1 step 1). Bootstrap overlay is NOT invoked even if registered.
 *
 * - `bootstrap input` — fed via CLI `--bootstrap-json` /
 *   MCP `bootstrapInput` / programmatic `bootstrapInput`. Passed to the
 *   overlay's `run(ctx, params)` after validation against the overlay's
 *   `params` schema. Only meaningful when an overlay is registered AND
 *   the run uses overlay mode.
 *
 * - `force standalone` (debug) — for no-needs cases marked
 *   `runnability.requireAttachment: true`, allows bypassing the
 *   "requires attachment" guard. §6.3 escape valve. Author-debug only;
 *   warning emitted at runtime.
 *
 * The channel is process-local (a plain Map). Subprocess boundaries are
 * the harness's responsibility — it serializes runner options, spawns the
 * subprocess with env vars / args, and the harness's `setRuntime`-time
 * code populates this channel before the user module imports.
 *
 * @internal
 */

interface RunnerInputs {
  explicit: Map<string, unknown>;
  bootstrap: Map<string, unknown>;
  forceStandalone: Set<string>;
}

const _state: RunnerInputs = {
  explicit: new Map(),
  bootstrap: new Map(),
  forceStandalone: new Set(),
};

/**
 * Set the explicit case input for a given testId. Subsequent dispatcher
 * runs of that testId will take this path (§5.1 step 1) regardless of
 * whether a bootstrap overlay is registered.
 *
 * @internal
 */
export function setExplicitInput(testId: string, input: unknown): void {
  _state.explicit.set(testId, input);
}

/**
 * Read the explicit case input for a given testId. Returns
 * `{ has: true, value }` when present (including when value is
 * `undefined` / `null` / `false`), `{ has: false }` otherwise.
 *
 * @internal
 */
export function getExplicitInput(
  testId: string,
): { has: true; value: unknown } | { has: false } {
  if (!_state.explicit.has(testId)) return { has: false };
  return { has: true, value: _state.explicit.get(testId) };
}

/**
 * Set the bootstrap params for a given testId. Read by the dispatcher
 * when invoking an overlay (§5.1 step 3a).
 *
 * @internal
 */
export function setBootstrapInput(testId: string, input: unknown): void {
  _state.bootstrap.set(testId, input);
}

/**
 * Read the bootstrap params for a given testId.
 *
 * @internal
 */
export function getBootstrapInput(
  testId: string,
): { has: true; value: unknown } | { has: false } {
  if (!_state.bootstrap.has(testId)) return { has: false };
  return { has: true, value: _state.bootstrap.get(testId) };
}

/**
 * Mark a testId as force-standalone (§6.3 debug escape valve for
 * `requireAttachment` no-needs cases). The dispatcher will bypass the
 * `requireAttachment` guard for this testId; a runtime warning is
 * emitted alongside.
 *
 * @internal
 */
export function setForceStandalone(testId: string): void {
  _state.forceStandalone.add(testId);
}

/**
 * Check whether a testId is force-standalone.
 *
 * @internal
 */
export function isForceStandalone(testId: string): boolean {
  return _state.forceStandalone.has(testId);
}

/**
 * Clear all runner-supplied inputs. Test hook; not part of the public
 * API. Called by harness teardown and by tests that want a clean slate.
 *
 * @internal
 */
export function clearRunnerInputs(): void {
  _state.explicit.clear();
  _state.bootstrap.clear();
  _state.forceStandalone.clear();
}
