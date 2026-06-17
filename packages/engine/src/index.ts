/**
 * @glubean/engine — environment-agnostic run-loop core (Stage 1 spike).
 *
 * The shared execution core both hosts reference: `@glubean/runner` (NodeHost)
 * and lite's BrowserHost. Hosts implement the ports (fetch / EnvProvider /
 * EventSink / Scheduler / Carrier) and drive `RunnerCore`; the run-loop semantics
 * live here, written once. HTTP is real ky in both hosts (Decision B) — the host
 * seam is the web-standard `fetch`.
 */
export { RunnerCore, toTestDef } from "./engine.js";
export type { SdkTestShape } from "./engine.js";
export type {
  DataProvider,
  EngineContext,
  EnvProvider,
  EventSink,
  ExecutionEvent,
  ExecutionScope,
  FeaturePolicy,
  FetchImpl,
  ModuleLoader,
  RunnerServices,
  Scheduler,
  ScopeInput,
  StepDef,
  TestDef,
  TestFn,
  TestResult,
} from "./types.js";
