import { describe, expect, test } from "vitest";
import { resolveTemplate, type GlubeanRuntime } from "@glubean/sdk";

import { browser } from "./plugin.js";

function makeRuntime(
  vars: Record<string, string> = {},
  secrets: Record<string, string> = {},
): GlubeanRuntime {
  return {
    vars,
    secrets,
    http: {} as GlubeanRuntime["http"],
    requireVar: (key) => {
      const value = vars[key];
      if (!value) throw new Error(`Missing required variable: ${key}`);
      return value;
    },
    requireSecret: (key) => {
      const value = secrets[key];
      if (!value) throw new Error(`Missing required secret: ${key}`);
      return value;
    },
    resolveTemplate: (template) => resolveTemplate(template, vars, secrets),
    action: () => {},
    trace: () => {},
    event: () => {},
    log: () => {},
  };
}

function resolvedBaseUrl(
  configured: string,
  vars: Record<string, string> = {},
): string | undefined {
  const client = browser({ launch: true, baseUrl: configured }).create(
    makeRuntime(vars),
  );
  return (client as unknown as { _baseUrl?: string })._baseUrl;
}

describe("browser baseUrl resolution", () => {
  test("accepts a literal absolute URL", () => {
    expect(resolvedBaseUrl("https://lingoak.app")).toBe(
      "https://lingoak.app",
    );
  });

  test("resolves a {{KEY}} template", () => {
    expect(
      resolvedBaseUrl("{{WEB_URL}}", { WEB_URL: "https://lingoak.app" }),
    ).toBe("https://lingoak.app");
  });

  test("keeps supporting a bare runtime variable name", () => {
    expect(
      resolvedBaseUrl("WEB_URL", { WEB_URL: "https://lingoak.app" }),
    ).toBe("https://lingoak.app");
  });
});
