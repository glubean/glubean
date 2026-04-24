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
 * Register a bootstrap overlay for a specific case. Called by
 * `contract.bootstrap(ref, spec)`.
 *
 * Throws if another overlay is already registered for the same testId.
 */
export function registerBootstrap<Needs, Params = void>(
  ref: ContractCaseRef<Needs, unknown>,
  spec: Bootstrap<Params, Needs>,
): BootstrapAttachment<Needs, Params> {
  const testId = `${ref.contractId}.${ref.caseKey}`;

  if (_bootstrapRegistry.has(testId)) {
    throw new Error(
      `contract.bootstrap: duplicate overlay for case "${testId}". ` +
        `Only one bootstrap overlay per case is allowed. ` +
        `If you need multiple variants, use the \`bootstrap.params\` schema.`,
    );
  }

  _bootstrapRegistry.set(testId, {
    testId,
    contractId: ref.contractId,
    caseKey: ref.caseKey,
    protocol: ref.protocol,
    spec: spec as Bootstrap<unknown, unknown>,
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
}
