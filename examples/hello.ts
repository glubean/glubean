/**
 * Example test file demonstrating the Glubean SDK.
 *
 * Run with: deno task example
 * Or: deno task cli run ./examples/hello.ts
 */

import { test } from "@glubean/sdk";

/**
 * A simple test that always passes.
 */
export const helloWorld = test(
  {
    id: "hello-world",
    name: "Hello World Test",
    tags: ["smoke", "example"],
  },
  async (ctx) => {
    ctx.log("Starting hello world test...");
    ctx.log("Environment vars", ctx.vars);

    // Overload 1: Simple boolean assertion
    ctx.assert(true, "Hello World assertion passed");

    // Overload 1 with details
    ctx.assert(1 + 1 === 2, "Math works", { actual: 1 + 1, expected: 2 });

    ctx.log("Test completed successfully!");
  }
);

/**
 * A test that demonstrates API testing with fetch and tracing.
 */
export const apiTest = test(
  {
    id: "api-health",
    name: "API Health Check",
    tags: ["api", "smoke"],
  },
  async (ctx) => {
    const baseUrl = ctx.vars.BASE_URL || "https://httpbin.org";
    ctx.log(`Testing API at: ${baseUrl}`);

    const startTime = Date.now();
    try {
      const response = await fetch(`${baseUrl}/get`);
      const duration = Date.now() - startTime;
      const data = await response.json();

      // Trace the API call
      ctx.trace({
        method: "GET",
        url: `${baseUrl}/get`,
        status: response.status,
        duration,
        responseBody: data,
      });

      // Overload 2: Explicit result object with actual/expected
      ctx.assert(
        { passed: response.ok, actual: response.status, expected: 200 },
        "API responds with 200 OK"
      );

      // Overload 1: Simple boolean
      ctx.assert(data.url !== undefined, "Response contains URL field");
    } catch (error) {
      ctx.assert(false, `API request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
);

/**
 * A test that demonstrates a failing assertion with details.
 */
export const failingTest = test(
  {
    id: "failing-example",
    name: "Failing Test Example",
    tags: ["example", "fail"],
  },
  async (ctx) => {
    ctx.log("This test demonstrates a failing assertion");

    // Overload 2: Explicit result object showing expected vs actual
    ctx.assert(
      { passed: false, actual: "failure", expected: "success" },
      "Intentionally failing assertion"
    );
  }
);
