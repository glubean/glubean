import { describe, it, expect } from "vitest";
import { bearer, basicAuth, apiKey } from "./index.js";

describe("bearer", () => {
  it("returns ConfigureHttpOptions with Authorization header", () => {
    const opts = bearer({ prefixUrl: "{{BASE_URL}}", token: "{{TOKEN}}" });
    expect(opts.prefixUrl).toBe("{{BASE_URL}}");
    expect(opts.headers).toEqual({ Authorization: "Bearer {{TOKEN}}" });
  });

  it("supports literal values", () => {
    const opts = bearer({ prefixUrl: "https://api.example.com", token: "sk-123" });
    expect(opts.prefixUrl).toBe("https://api.example.com");
    expect(opts.headers).toEqual({ Authorization: "Bearer sk-123" });
  });
});

describe("basicAuth", () => {
  it("returns ConfigureHttpOptions with beforeRequest hook", () => {
    const opts = basicAuth({ prefixUrl: "{{BASE_URL}}", username: "{{USER}}", password: "{{PASS}}" });
    expect(opts.prefixUrl).toBe("{{BASE_URL}}");
    expect(opts.hooks?.beforeRequest).toHaveLength(1);
  });

  it("hook computes base64 from marker header", async () => {
    const opts = basicAuth({ prefixUrl: "{{BASE_URL}}", username: "{{USER}}", password: "{{PASS}}" });
    const hook = opts.hooks!.beforeRequest![0];

    const request = new Request("https://example.com", {
      headers: { "X-Glubean-Basic-Auth": "admin:secret123" },
    });
    const result = await hook({ request, options: {} } as never) as Request;

    expect(result.headers.get("Authorization")).toBe(
      `Basic ${Buffer.from("admin:secret123").toString("base64")}`
    );
    expect(result.headers.has("X-Glubean-Basic-Auth")).toBe(false);
  });
});

describe("apiKey", () => {
  it("header mode: sets header with value", () => {
    const opts = apiKey({ prefixUrl: "{{BASE_URL}}", param: "X-API-Key", value: "{{MY_KEY}}" });
    expect(opts.headers).toEqual({ "X-API-Key": "{{MY_KEY}}" });
    expect(opts.hooks).toBeUndefined();
  });

  it("query mode: uses beforeRequest hook", async () => {
    const opts = apiKey({ prefixUrl: "{{BASE_URL}}", param: "api_key", value: "{{MY_KEY}}", location: "query" });
    expect(opts.hooks?.beforeRequest).toHaveLength(1);

    const hook = opts.hooks!.beforeRequest![0];
    const request = new Request("https://example.com/path", {
      headers: { "X-Glubean-ApiKey-Query": "my-secret-key" },
    });
    const result = await hook({ request, options: {} } as never) as Request;

    const url = new URL(result.url);
    expect(url.searchParams.get("api_key")).toBe("my-secret-key");
    expect(result.headers.has("X-Glubean-ApiKey-Query")).toBe(false);
  });

  it("supports literal values", () => {
    const opts = apiKey({ prefixUrl: "https://api.example.com", param: "apiKey", value: "sk-123", location: "query" });
    expect(opts.prefixUrl).toBe("https://api.example.com");
    expect(opts.headers).toEqual({ "X-Glubean-ApiKey-Query": "sk-123" });
  });
});
