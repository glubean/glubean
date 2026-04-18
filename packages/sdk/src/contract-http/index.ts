/**
 * Built-in HTTP adapter for the Glubean contract system.
 *
 * HTTP ships with the SDK (users get `contract.http.with()` zero-config),
 * but internally it implements the same `ContractProtocolAdapter` interface
 * that future protocol plugins (@glubean/contract-grpc etc.) will use.
 *
 * This module is re-exported and auto-registered by `@glubean/sdk`'s main
 * entry point. End users do not import from here directly.
 *
 * Populated in P2 of the v0.2.0 rewrite
 * (`internal/30-execution/2026-04-18/contract-rewrite-plan.md`).
 */

export {};
