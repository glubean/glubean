/**
 * Test skip logic based on requires / defaultRun / deferred.
 * Extracted from run.ts so it can be unit-tested independently.
 */

export interface CapabilityProfile {
  /** Can run browser-interactive cases */
  browser: boolean;
  /** Can run out-of-band cases (email, SMS, webhook) */
  outOfBand: boolean;
  /** Can run opt-in cases (expensive, slow) */
  optIn: boolean;
}

/**
 * Check if a test should be skipped based on its requires/defaultRun/deferred
 * and the current capability profile.
 *
 * Returns undefined if the test should run, or a skip reason string.
 */
export function shouldSkipTest(
  meta: { requires?: string; defaultRun?: string; deferred?: string },
  profile: CapabilityProfile,
): string | undefined {
  // Deferred cases are never runnable — no flag can enable them
  if (meta.deferred) {
    return `deferred: ${meta.deferred}`;
  }

  const requires = meta.requires ?? "headless";
  const defaultRun = meta.defaultRun ?? "always";

  // Check requires capability
  if (requires === "browser" && !profile.browser) {
    return `requires: browser (use --include-browser to run)`;
  }
  if (requires === "out-of-band" && !profile.outOfBand) {
    return `requires: out-of-band (use --include-out-of-band to run)`;
  }

  // Check defaultRun policy
  if (defaultRun === "opt-in") {
    // Non-headless opt-in: already handled by requires check above
    // Headless opt-in: needs explicit --include-opt-in
    if (requires === "headless" && !profile.optIn) {
      return `defaultRun: opt-in (use --include-opt-in to run)`;
    }
    // Non-headless + included via --include-browser/--include-out-of-band: allow
  }

  return undefined;
}
