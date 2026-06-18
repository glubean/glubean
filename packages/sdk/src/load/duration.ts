import type { LoadDuration } from "./runner.js";

/**
 * Parse a `LoadDuration` into milliseconds.
 *
 * Accepts a number (already ms) or a string with a unit suffix:
 * `"500ms"`, `"60s"`, `"2m"`, `"1h"` (and decimals like `"1.5s"`).
 */
export function parseDurationMs(duration: LoadDuration): number {
  if (typeof duration === "number") {
    if (!Number.isFinite(duration) || duration < 0) {
      throw new Error(`invalid duration: ${duration} (must be a finite, non-negative number of ms)`);
    }
    return duration;
  }
  const match = duration.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/);
  if (!match) {
    throw new Error(
      `invalid duration string: "${duration}" (use e.g. "500ms", "60s", "2m", "1h")`,
    );
  }
  const value = Number(match[1]);
  const multiplier =
    match[2] === "ms" ? 1 : match[2] === "s" ? 1000 : match[2] === "m" ? 60_000 : 3_600_000;
  return value * multiplier;
}
