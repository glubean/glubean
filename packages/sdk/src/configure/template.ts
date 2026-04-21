/**
 * @module configure/template
 *
 * `{{key}}` placeholder resolution used by vars, secrets, and http builders.
 *
 * Resolution priority: session → secrets → vars.
 */

/** Regex for `{{key}}` template placeholders. */
export const TEMPLATE_RE = /\{\{([\w-]+)\}\}/g;

/**
 * Resolve `{{key}}` template placeholders in a string.
 *
 * Resolution priority (first non-empty wins):
 * 1. Session — dynamic values set during session setup (e.g., auth tokens)
 * 2. Secrets — from `.env.secrets`
 * 3. Vars — from `.env`
 *
 * Session values must be strings to resolve in templates. Non-string session
 * values are silently skipped (they're still accessible via `ctx.session.get()`).
 */
export function resolveTemplate(
  template: string,
  vars: Record<string, string>,
  secrets: Record<string, string>,
  session?: Record<string, unknown>,
): string {
  return template.replace(TEMPLATE_RE, (_match, key: string) => {
    const sessionValue = session?.[key];
    const value =
      (typeof sessionValue === "string" ? sessionValue : undefined) ??
      secrets[key] ??
      vars[key];
    if (value === undefined || value === null || value === "") {
      throw new Error(
        `Missing value for template placeholder "{{${key}}}" in configure() http headers. ` +
          `Ensure "${key}" is available in session, as a secret, or as a var.`,
      );
    }
    return value;
  });
}
