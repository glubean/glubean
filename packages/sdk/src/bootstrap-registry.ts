/**
 * Bootstrap attachment registry.
 *
 * Per contract-attachment-model.md v1.3:
 *   - `contract.bootstrap(ref, spec)` registers an overlay targeting a
 *     specific contract case (identified by testId = `${contractId}.${caseKey}`).
 *   - Each test id may have at most one bootstrap overlay. Duplicate
 *     registration throws.
 *   - Registry is consulted by the runner at runnable resolution time
 *     (single-case-execution-api §5.1 algorithm).
 *
 * The registry is a process-global side-effect map. Modules that export
 * `contract.bootstrap(...)` register on evaluation. Scanner / runner are
 * responsible for eager module loading per attachment model §7.4.
 */

import type {
  BootstrapAttachment,
  Bootstrap,
  ContractCaseRef,
} from "./contract-types.js";

interface BootstrapRegistration {
  testId: string;
  contractId: string;
  caseKey: string;
  protocol: string;
  spec: Bootstrap<unknown, unknown>;
}

const _bootstrapRegistry = new Map<string, BootstrapRegistration>();

/**
 * Named bootstrap registry — reusable overlays defined once and attached to
 * many cases by name (GLU-236 / P1-6). Motivating case: a "signed-in-session"
 * bootstrap that logs in and returns the session, shared by every browser
 * journey that must START signed-in instead of re-authoring the login per case.
 */
const _namedBootstraps = new Map<string, Bootstrap<unknown, unknown>>();

/** A reference to a named bootstrap, in place of an inline spec. */
export interface NamedBootstrapUse {
  use: string;
}

/** Type guard for a `{ use: "<name>" }` named-bootstrap reference. */
export function isNamedBootstrapUse(spec: unknown): spec is NamedBootstrapUse {
  return (
    !!spec &&
    typeof spec === "object" &&
    typeof (spec as { use?: unknown }).use === "string" &&
    // A plain fn or {run} is not a use-ref; only a bare {use} object is.
    typeof (spec as { run?: unknown }).run !== "function"
  );
}

/**
 * Define a reusable named bootstrap. Attach it to a case with
 * `contract.bootstrap(ref, { use: name })`. Throws on a duplicate name.
 */
export function defineNamedBootstrap<Params = void, Output = unknown>(
  name: string,
  spec: Bootstrap<Params, Output>,
): void {
  if (_namedBootstraps.has(name)) {
    throw new Error(
      `contract.bootstrap.define: duplicate named bootstrap "${name}". ` +
        `Each name may be defined once.`,
    );
  }
  _namedBootstraps.set(name, spec as Bootstrap<unknown, unknown>);
}

/** Look up a named bootstrap spec. Returns undefined if none. */
export function getNamedBootstrap(name: string): Bootstrap<unknown, unknown> | undefined {
  return _namedBootstraps.get(name);
}

/**
 * Register a bootstrap overlay for a specific case. Called by
 * `contract.bootstrap(ref, spec)`. `spec` may be an inline `Bootstrap` OR a
 * `{ use: "<name>" }` reference to a `contract.bootstrap.define(...)` overlay,
 * which is resolved here (so the runner's `getBootstrap` is unchanged).
 *
 * Throws if another overlay is already registered for the same testId, or if a
 * named reference points at an undefined name.
 */
export function registerBootstrap<Needs, Params = void>(
  ref: ContractCaseRef<Needs, unknown>,
  spec: Bootstrap<Params, Needs> | NamedBootstrapUse,
): BootstrapAttachment<Needs, Params> {
  const testId = `${ref.contractId}.${ref.caseKey}`;

  if (_bootstrapRegistry.has(testId)) {
    throw new Error(
      `contract.bootstrap: duplicate overlay for case "${testId}". ` +
        `Only one bootstrap overlay per case is allowed. ` +
        `If you need multiple variants, use the \`bootstrap.params\` schema.`,
    );
  }

  let resolved: Bootstrap<unknown, unknown>;
  if (isNamedBootstrapUse(spec)) {
    const named = _namedBootstraps.get(spec.use);
    if (!named) {
      throw new Error(
        `contract.bootstrap: unknown named bootstrap "${spec.use}". ` +
          `Define it first with contract.bootstrap.define("${spec.use}", ...).`,
      );
    }
    resolved = named;
  } else {
    resolved = spec as Bootstrap<unknown, unknown>;
  }

  _bootstrapRegistry.set(testId, {
    testId,
    contractId: ref.contractId,
    caseKey: ref.caseKey,
    protocol: ref.protocol,
    spec: resolved,
  });

  return {
    __glubean_type: "bootstrap-attachment",
    testId,
  } as BootstrapAttachment<Needs, Params>;
}

/** Look up a bootstrap registration by testId. Returns undefined if none. */
export function getBootstrap(
  testId: string,
): BootstrapRegistration | undefined {
  return _bootstrapRegistry.get(testId);
}

/** Enumerate all registered bootstrap overlays. Used by scanner / CLI list. */
export function listBootstraps(): BootstrapRegistration[] {
  return [..._bootstrapRegistry.values()];
}

/** Test-only: clear the registry between test runs. Not part of public API. */
export function clearBootstrapRegistry(): void {
  _bootstrapRegistry.clear();
  _namedBootstraps.clear();
}
