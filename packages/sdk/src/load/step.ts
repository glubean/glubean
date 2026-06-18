/**
 * Load scenario step authoring types.
 *
 * These mirror the `test().builder()` step model (return-state threading:
 * a step returns the next state, or `void`/`undefined` to keep the current
 * state) but bind to `LoadContext` and add a load-specific assertion policy.
 */
import type { StepMeta } from "../types.js";
import type { LoadContext } from "./context.js";

/**
 * What happens when a guard/assertion fails inside a load step.
 *
 * Resolution order (most specific wins):
 *   per-assertion `.orFail()` / thrown error
 *     > step-level `assertions.onFailure`
 *     > scenario-level `assertions.onFailure`
 *     > loadRunner `assertions.onFailure`
 *     > default `"continue"`
 */
export type LoadAssertionFailureMode =
  /** Default: record + count the failure, keep running the scenario. */
  | "continue"
  /** Current step completes; remaining steps are skipped. */
  | "skipRemainingSteps"
  /** Fail-fast the current iteration. */
  | "abortIteration";

/** Per-step options for `loadScenario` steps (`StepMeta` minus `name`, plus load policy). */
export type LoadStepOptions = Omit<StepMeta, "name"> & {
  assertions?: {
    onFailure?: LoadAssertionFailureMode;
  };
};

/** A scenario `setup` producing the initial state from the context. */
export type LoadSetupFunction<Input, NewState> = (
  ctx: LoadContext<Input>,
) => Promise<NewState>;

/**
 * A scenario step. Returns the next state, or `void`/`undefined` to keep the
 * current state (matching `test().builder()` semantics).
 */
export type LoadStepFunction<Input, State, NewState = State> = (
  ctx: LoadContext<Input>,
  state: State,
) => Promise<NewState | void>;

/** A scenario `teardown`, always run with the last committed state. */
export type LoadTeardownFunction<Input, State> = (
  ctx: LoadContext<Input>,
  state: State,
) => Promise<void>;
