/**
 * Static projection of a `LoadPlan` for discovery / metadata (M2).
 *
 * Resolves scenario references (builder → built scenario) and normalizes
 * durations to ms, without executing anything. Discovery surfaces only
 * `loadRunner()` exports; the referenced scenarios are workloads.
 */
import type { LoadBuilder } from "./builder.js";
import { parseDurationMs } from "./duration.js";
import type { LoadPlan, LoadScenarioRef } from "./runner.js";
import type { LoadScenario } from "./scenario.js";

/** One scenario reference within a projected plan. */
export interface LoadScenarioRefProjection {
  /** Traffic-mix entry id, if this came from a mix. */
  scenarioRefId?: string;
  /** The referenced loadScenario id. */
  scenarioId: string;
  /** Traffic-mix weight, if any. */
  weight?: number;
  /** Top-level step names (for display). */
  steps: string[];
}

/** Static, discovery-facing summary of a load plan. */
export interface LoadProjection {
  runnerId: string;
  runMode: "load";
  concurrency: number;
  durationMs?: number;
  iterations?: number;
  rampUpMs?: number;
  scenarios: LoadScenarioRefProjection[];
  /** Which threshold scopes are configured (transaction / endpoints / steps / …). */
  thresholdScopes: string[];
}

function resolveScenario(ref: LoadScenarioRef): LoadScenario {
  if ((ref as { __glubean_type?: string }).__glubean_type === "load-scenario-builder") {
    return (ref as LoadBuilder).build();
  }
  return ref as LoadScenario;
}

function stepNames(scenario: LoadScenario): string[] {
  return scenario.steps.map((step) => step.meta.name);
}

/** Project a `LoadPlan` into a static `LoadProjection` (pure; no execution). */
export function projectLoadPlan(plan: LoadPlan): LoadProjection {
  const cfg = plan.config;
  const scenarios: LoadScenarioRefProjection[] = [];

  if ("scenarios" in cfg) {
    for (const entry of cfg.scenarios) {
      const scenario = resolveScenario(entry.scenario);
      scenarios.push({
        scenarioRefId: entry.id,
        scenarioId: scenario.meta.id,
        weight: entry.weight,
        steps: stepNames(scenario),
      });
    }
  } else {
    const scenario = resolveScenario(cfg.scenario);
    scenarios.push({ scenarioId: scenario.meta.id, steps: stepNames(scenario) });
  }

  return {
    runnerId: plan.id,
    runMode: "load",
    concurrency: cfg.concurrency,
    ...(cfg.duration !== undefined ? { durationMs: parseDurationMs(cfg.duration) } : {}),
    ...(cfg.iterations !== undefined ? { iterations: cfg.iterations } : {}),
    ...(cfg.rampUp !== undefined ? { rampUpMs: parseDurationMs(cfg.rampUp) } : {}),
    scenarios,
    thresholdScopes: cfg.thresholds ? Object.keys(cfg.thresholds) : [],
  };
}
