/**
 * @module runner-input-templating
 *
 * `{{VAR}}` substitution for runner-supplied inputs (attachment-model
 * §8). The runner interpolates string scalars before schema validation;
 * `env` is never read inside bootstrap (§8).
 *
 * Patterns supported (per §8 spec — kept minimal in v0):
 *   - `{{VAR}}` — substitute the entire string with the env value
 *     (preserves type only when string; numeric envs stay strings)
 *   - `prefix-{{VAR}}-suffix` — string interpolation; result is a string
 *   - `{{VAR1}}{{VAR2}}` — multiple substitutions in one string
 *
 * Errors:
 *   - Missing required var → `Error("Templating: missing env var \"VAR\"")`
 *   - Whitespace inside braces is stripped; `{{ VAR }}` works.
 *
 * Scope:
 *   - Recursive across plain objects and arrays.
 *   - Strings get substitution; numbers / booleans / null pass through.
 *   - Functions / class instances / Maps / Sets / etc. are unsupported
 *     for v0 (the input is JSON-shaped by the time it reaches us, so
 *     this is fine).
 */

const PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/**
 * Apply `{{VAR}}` substitution to all string scalars inside `value`,
 * resolving variables from `env`. Returns a new value (does not mutate
 * the input).
 *
 * @throws when a referenced var is missing in `env`.
 */
export function applyEnvTemplating(
  value: unknown,
  env: Record<string, string | undefined>,
): unknown {
  if (typeof value === "string") {
    return substituteString(value, env);
  }
  if (Array.isArray(value)) {
    return value.map((item) => applyEnvTemplating(item, env));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = applyEnvTemplating(v, env);
    }
    return out;
  }
  return value;
}

function substituteString(
  s: string,
  env: Record<string, string | undefined>,
): string {
  // Reset stateful regex.
  PATTERN.lastIndex = 0;

  // Fast-path: no braces present → nothing to do (preserves identity-
  // sensitive string equality on hot paths).
  if (!s.includes("{{")) return s;

  return s.replace(PATTERN, (_match, varName: string) => {
    const v = env[varName];
    if (v === undefined) {
      throw new Error(
        `Templating: missing env var "${varName}" referenced in runner input. ` +
          `Set it in your environment or .env file (CLI / MCP read both).`,
      );
    }
    return v;
  });
}
