import { describe, expect, test } from "vitest";
import { scrubEnvSecrets } from "./qa.js";

/**
 * `scrubEnvSecrets` is the belt-and-suspenders pass that runs AFTER the
 * redaction pipeline on a serialized QA report. codex GLU-212 R8 P2 caught a
 * regression where the earlier all-env version erased attributable non-secrets
 * (the resolved model id from GLUBEAN_QA_MODEL, BASE_URL evidence). These tests
 * pin the key-gated behavior: credential-NAMED env values are scrubbed, plain
 * config env values are preserved verbatim.
 */
describe("scrubEnvSecrets", () => {
  test("scrubs the value of a credential-named env var", () => {
    const secret = "opaque-session-token-abc123";
    const json = JSON.stringify({ finalUrl: `https://app/cb?token=${secret}` });
    const out = scrubEnvSecrets(json, { GLUBEAN_SESSION_TOKEN: secret });
    expect(out).not.toContain(secret);
    expect(out).toContain("«redacted-secret»");
  });

  test("preserves GLUBEAN_QA_MODEL — the report's attributable model id", () => {
    const model = "claude-sonnet-5";
    const json = JSON.stringify({ executor: { model } });
    const out = scrubEnvSecrets(json, { GLUBEAN_QA_MODEL: model });
    // Not credential-named → must survive so the report stays attributable.
    expect(out).toContain(model);
    expect(out).not.toContain("«redacted-secret»");
  });

  test("preserves BASE_URL evidence", () => {
    const baseUrl = "https://app.staging.glubean.com";
    const json = JSON.stringify({ finalUrl: `${baseUrl}/dashboard` });
    const out = scrubEnvSecrets(json, { BASE_URL: baseUrl });
    expect(out).toContain(baseUrl);
  });

  test("scrubs a credential-BEARING URL even when the key is not credential-named", () => {
    // codex GLU-212 R9 P1: DATABASE_URL embeds a password in its userinfo. The
    // key name has no credential keyword, but the value is a secret and the
    // pattern pass won't reliably parse arbitrary credentialed URLs.
    const dbUrl = "postgres://svc_user:opaque-pass-42@db.internal:5432/app";
    const json = JSON.stringify({ consoleError: `connect failed: ${dbUrl}` });
    const out = scrubEnvSecrets(json, { DATABASE_URL: dbUrl });
    expect(out).not.toContain(dbUrl);
    expect(out).not.toContain("opaque-pass-42");
    expect(out).toContain("«redacted-secret»");
  });

  test("preserves a plain (userinfo-free) URL under a non-credential key", () => {
    // AMQP/redis-style connection string WITHOUT embedded creds must survive —
    // the userinfo signal is what distinguishes it from DATABASE_URL above.
    const plain = "https://api.example.com/v1/health?region=us-east-1";
    const out = scrubEnvSecrets(JSON.stringify({ url: plain }), { SERVICE_URL: plain });
    expect(out).toContain(plain);
  });

  test("common credential key aliases all match (substring, case-insensitive)", () => {
    for (const key of [
      "MY_PASSWORD",
      "APP_API_KEY",
      "ci_secret",
      "X_ACCESS_TOKEN",
      "SERVICE_CREDENTIAL",
    ]) {
      const secret = "value-worth-hiding-9f8e7d";
      const out = scrubEnvSecrets(JSON.stringify({ v: secret }), { [key]: secret });
      expect(out, `${key} should be treated as a credential key`).not.toContain(secret);
    }
  });

  test("does not scrub short credential values (< 6 chars) to avoid collisions", () => {
    // A 5-char value would collide with ordinary report substrings; the guard
    // leaves it to the pattern pipeline rather than corrupting evidence.
    const json = JSON.stringify({ note: "abcde and more" });
    const out = scrubEnvSecrets(json, { TOKEN: "abcde" });
    expect(out).toContain("abcde");
  });

  test("bare 'auth'-style keys are NOT scrubbed (mirrors CREDENTIAL_KEYS)", () => {
    // CREDENTIAL_KEYS deliberately excludes bare `auth`/`key` to avoid
    // corrupting non-secret fields; the scrub inherits that exact policy.
    const value = "author-name-not-a-secret";
    const out = scrubEnvSecrets(JSON.stringify({ v: value }), { AUTHOR: value });
    expect(out).toContain(value);
  });
});
