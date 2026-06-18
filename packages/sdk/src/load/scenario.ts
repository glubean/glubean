/**
 * loadScenario definition shape + branch/poll runtime data.
 *
 * These mirror the test() step / branch / poll runtime structures, but bind to
 * `LoadContext` and carry a load-specific per-step assertion policy. The load
 * orchestrator (later milestones) executes these. They are intentionally
 * independent of `Test` / `TestEvent` structures so load's bounded-aggregation
 * model never inherits ordinary test timeline semantics.
 */
import type { StepJsonScalar, StepMeta, StepNoExtraKeys } from "../types.js";
import type { LoadContext } from "./context.js";
import type { LoadAssertionFailureMode, LoadStepOptions } from "./step.js";

/** Step metadata for a load scenario step: StepMeta plus a load assertion policy. */
export interface LoadStepMeta extends StepMeta {
  assertions?: {
    onFailure?: LoadAssertionFailureMode;
  };
}

/**
 * A scenario step's runtime structure. A normal step has a callable `fn`; a
 * branch step (condition/switch) additionally carries `branch`, and a poll step
 * carries `poll` — for both, `fn` is a throwing stub and the orchestrator
 * dispatches on the extra field.
 */
export interface LoadStepDefinition<Input = unknown, S = unknown> {
  meta: LoadStepMeta;
  fn: (ctx: LoadContext<Input>, state: S) => Promise<S | void>;
  branch?: LoadBranchData<Input, S>;
  poll?: LoadPollData<Input, S>;
}

/** Runtime branch data (condition / switchOn / switchCond) bound to LoadContext. */
export interface LoadBranchData<Input = unknown, S = unknown> {
  mode: "predicate" | "value";
  message?: string;
  /** value-mode only: subject lens evaluated once against committed state. */
  subject?: (ctx: LoadContext<Input>, state: S) => unknown;
  cases: Array<{
    predicate?: (ctx: LoadContext<Input>, state: S) => boolean | Promise<boolean>;
    value?: StepJsonScalar;
    message?: string;
    steps: LoadStepDefinition<Input, S>[];
  }>;
  default: LoadStepDefinition<Input, S>[];
}

/** Runtime poll data (bounded poll-until) bound to LoadContext. */
export interface LoadPollData<Input = unknown, S = unknown> {
  fn: (ctx: LoadContext<Input>, state: S) => Promise<unknown>;
  until: (ctx: LoadContext<Input>, res: unknown, state: S) => boolean | Promise<boolean>;
  out?: (state: S, res: unknown) => unknown;
  every?: number;
  backoff?: number;
  timeout?: number;
  perAttemptTimeout?: number;
  maxAttempts?: number;
}

/** Narrow a LoadStepDefinition to a branch step. */
export function isLoadBranchStep<Input, S>(
  step: LoadStepDefinition<Input, S>,
): step is LoadStepDefinition<Input, S> & { branch: LoadBranchData<Input, S> } {
  return step.branch !== undefined;
}

/** Narrow a LoadStepDefinition to a poll step. */
export function isLoadPollStep<Input, S>(
  step: LoadStepDefinition<Input, S>,
): step is LoadStepDefinition<Input, S> & { poll: LoadPollData<Input, S> } {
  return step.poll !== undefined;
}

/** `loadScenario().condition` spec — arbitrary runtime predicate. */
export interface LoadConditionSpec<Input = unknown, S = unknown> {
  predicate: (ctx: LoadContext<Input>, state: S) => boolean | Promise<boolean>;
  message?: string;
}

/** `loadScenario().poll` options. `Res` is inferred from the attempt `fn`'s return. */
export interface LoadPollOpts<Input, S, Res, NewS> {
  until: (ctx: LoadContext<Input>, res: Res, state: S) => boolean | Promise<boolean>;
  every?: number;
  backoff?: number;
  timeout?: number;
  perAttemptTimeout?: number;
  maxAttempts?: number;
  out?: (state: S, res: Res) => NewS;
}

/** Module-private phantom brand making LoadFragmentBuilder invariant in State. */
declare const LOAD_FRAGMENT_STATE: unique symbol;

/**
 * Restricted builder for a `loadScenario()` branch body (condition then/else,
 * switch case/default). Exposes step / use / condition / switchOn / switchCond /
 * poll and accumulates them into the branch node; it deliberately does NOT
 * expose setup / teardown / meta / build. Invariant in `State` via the phantom
 * brand (same convergence guarantee as TestFragmentBuilder).
 */
export interface LoadFragmentBuilder<Input = unknown, S = unknown> {
  readonly [LOAD_FRAGMENT_STATE]: (s: S) => S;

  step(
    name: string,
    fn: (ctx: LoadContext<Input>, state: S) => Promise<void>,
  ): LoadFragmentBuilder<Input, S>;
  step<NewS>(
    name: string,
    fn: (ctx: LoadContext<Input>, state: S) => Promise<NewS>,
  ): LoadFragmentBuilder<Input, NewS>;
  step(
    name: string,
    options: LoadStepOptions,
    fn: (ctx: LoadContext<Input>, state: S) => Promise<void>,
  ): LoadFragmentBuilder<Input, S>;
  step<NewS>(
    name: string,
    options: LoadStepOptions,
    fn: (ctx: LoadContext<Input>, state: S) => Promise<NewS>,
  ): LoadFragmentBuilder<Input, NewS>;

  use<NewS>(
    fn: (b: LoadFragmentBuilder<Input, S>) => LoadFragmentBuilder<Input, NewS>,
  ): LoadFragmentBuilder<Input, NewS>;

  condition<R extends S = S>(
    spec: LoadConditionSpec<Input, S>,
    thenBranch: (
      b: LoadFragmentBuilder<Input, S>,
    ) => LoadFragmentBuilder<Input, R & StepNoExtraKeys<R, S>>,
  ): LoadFragmentBuilder<Input, S>;
  condition<T>(
    spec: LoadConditionSpec<Input, S>,
    thenBranch: (b: LoadFragmentBuilder<Input, S>) => LoadFragmentBuilder<Input, T>,
    elseBranch: (b: LoadFragmentBuilder<Input, S>) => LoadFragmentBuilder<Input, NoInfer<T>>,
  ): LoadFragmentBuilder<Input, T>;

  switchOn<V>(
    lens: (ctx: LoadContext<Input>, state: S) => V,
  ): <T>(
    cases: ReadonlyArray<{
      value: [Exclude<Awaited<V>, undefined>] extends [StepJsonScalar]
        ? Exclude<Awaited<V>, undefined>
        : never;
      then: (b: LoadFragmentBuilder<Input, S>) => LoadFragmentBuilder<Input, NoInfer<T>>;
    }>,
    deflt: (b: LoadFragmentBuilder<Input, S>) => LoadFragmentBuilder<Input, T>,
  ) => LoadFragmentBuilder<Input, T>;

  switchCond<T>(
    cases: ReadonlyArray<{
      when: (ctx: LoadContext<Input>, state: S) => boolean | Promise<boolean>;
      then: (b: LoadFragmentBuilder<Input, S>) => LoadFragmentBuilder<Input, NoInfer<T>>;
    }>,
    deflt: (b: LoadFragmentBuilder<Input, S>) => LoadFragmentBuilder<Input, T>,
  ): LoadFragmentBuilder<Input, T>;

  poll<Res, NewS = S>(
    name: string,
    fn: (ctx: LoadContext<Input>, state: S) => Promise<Res>,
    opts: LoadPollOpts<Input, S, Res, NewS>,
  ): LoadFragmentBuilder<Input, NewS>;
}

/** Scenario-level metadata. */
export interface LoadScenarioMeta {
  id: string;
  description?: string;
  /** Scenario-level default for guard/assertion failures. */
  assertions?: {
    onFailure?: LoadAssertionFailureMode;
  };
}

/**
 * A complete loadScenario definition (output of `LoadBuilder.build()`).
 *
 * This is the performance-transaction workload that a `loadRunner()` executes.
 * It is NOT independently runnable — only `loadRunner()` exports are scheduled.
 */
export interface LoadScenario<Input = unknown, S = unknown> {
  readonly __glubean_type: "load-scenario";
  meta: LoadScenarioMeta;
  setup?: (ctx: LoadContext<Input>) => Promise<unknown>;
  steps: LoadStepDefinition<Input, unknown>[];
  teardown?: (ctx: LoadContext<Input>, state: S) => Promise<void>;
}
