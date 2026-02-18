/**
 * Dynamic login builder transform.
 *
 * Adds a "login" step to a test builder that:
 * 1. POSTs credentials to an endpoint
 * 2. Extracts an auth token from the response
 * 3. Creates an `authedHttp` client with the token injected
 *
 * The `authedHttp` client is passed to subsequent steps via the state chain.
 *
 * @module with_login
 */
import type { HttpClient, TestBuilder, TestContext } from "@glubean/sdk";

/**
 * Options for the `withLogin()` builder transform.
 */
export interface WithLoginOptions {
  /**
   * Login endpoint path or full URL.
   * Values may use `{{template}}` syntax for runtime resolution.
   */
  endpoint: string;

  /**
   * Credentials to POST as JSON body.
   * Values may use `{{template}}` syntax (e.g., `"{{user}}"`, `"{{pass}}"`),
   * which are resolved from `ctx.vars` and `ctx.secrets` at runtime.
   */
  credentials: Record<string, string>;

  /**
   * Function to extract the auth token from the login response body.
   * The body is the parsed JSON from the login response.
   *
   * @example
   * ```ts
   * extractToken: (body) => body.access_token
   * ```
   */
  // deno-lint-ignore no-explicit-any
  extractToken: (body: any) => string;

  /**
   * Header name for the auth token.
   * @default "Authorization"
   */
  headerName?: string;

  /**
   * Prefix for the auth token value in the header.
   * @default "Bearer "
   */
  headerPrefix?: string;
}

/**
 * Create a builder transform that adds a login step.
 *
 * The login step POSTs credentials to an endpoint, extracts a token, and
 * creates an `authedHttp` client with the token injected as a header.
 *
 * @param options Login configuration
 * @returns A builder transform function for use with `.use()`
 *
 * @example
 * ```ts
 * import { test } from "@glubean/sdk";
 * import { withLogin } from "@glubean/auth";
 *
 * test("protected-flow")
 *   .use(withLogin({
 *     endpoint: "/auth/login",
 *     credentials: { email: "{{user}}", password: "{{pass}}" },
 *     extractToken: (body) => body.access_token,
 *   }))
 *   .step("get profile", async (ctx, { authedHttp }) => {
 *     const me = await authedHttp.get("/me").json();
 *     ctx.expect(me.name).toBeDefined();
 *   });
 * ```
 */
export function withLogin<S>(
  options: WithLoginOptions,
): (builder: TestBuilder<S>) => TestBuilder<S & { authedHttp: HttpClient }> {
  const {
    endpoint,
    credentials,
    extractToken,
    headerName = "Authorization",
    headerPrefix = "Bearer ",
  } = options;

  return (builder: TestBuilder<S>) => {
    return builder.step(
      "login",
      async (
        ctx: TestContext,
        state: S,
      ): Promise<S & { authedHttp: HttpClient }> => {
        // Resolve template values in credentials
        const resolvedCredentials: Record<string, string> = {};
        for (const [key, value] of Object.entries(credentials)) {
          resolvedCredentials[key] = resolveTemplateFromCtx(value, ctx);
        }

        // Resolve endpoint
        const resolvedEndpoint = resolveTemplateFromCtx(endpoint, ctx);

        // POST to login endpoint
        const response = await ctx.http
          .post(resolvedEndpoint, {
            json: resolvedCredentials,
            throwHttpErrors: false,
          })
          .json();

        // Extract token
        const token = extractToken(response);
        if (!token || typeof token !== "string") {
          throw new Error(
            "withLogin: extractToken() did not return a valid string token",
          );
        }

        // Create authed HTTP client
        const authedHttp = ctx.http.extend({
          headers: {
            [headerName]: `${headerPrefix}${token}`,
          },
        });

        return { ...state, authedHttp };
      },
    );
  };
}

/**
 * Resolve `{{key}}` templates from ctx.vars and ctx.secrets.
 * Secrets take precedence over vars.
 */
function resolveTemplateFromCtx(template: string, ctx: TestContext): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const secretVal = ctx.secrets.get(key);
    if (secretVal !== undefined) return secretVal;
    const varVal = ctx.vars.get(key);
    if (varVal !== undefined) return varVal;
    return `{{${key}}}`;
  });
}
