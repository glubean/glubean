/**
 * Demo API tests — showcases Glubean SDK features against DummyJSON.
 *
 * This file is designed to produce rich, visually impressive results:
 * - Multiple test types (simple + multi-step builder)
 * - Auto-traced HTTP calls via ctx.http (method, URL, status, duration)
 * - Fluent assertions, structured logs
 * - Auth flows, data integrity checks, pagination
 *
 * Run: glubean run demo.test.ts --result-json
 */
import { test } from "@glubean/sdk";

// ---------------------------------------------------------------------------
// 1. Simple test — List products
// ---------------------------------------------------------------------------

export const listProducts = test(
  { id: "list-products", name: "List Products", tags: ["smoke"] },
  async (ctx) => {
    const baseUrl = ctx.vars.require("BASE_URL");

    const data = await ctx.http.get(`${baseUrl}/products?limit=5`).json<{
      products: unknown[];
      total: number;
    }>();

    ctx.expect(data.products.length).toBe(5);
    ctx.expect(data.total).toBeGreaterThan(0);

    ctx.log(`Found ${data.total} products total`);
  }
);

// ---------------------------------------------------------------------------
// 2. Simple test — Search products
// ---------------------------------------------------------------------------

export const searchProducts = test(
  { id: "search-products", name: "Search Products", tags: ["smoke"] },
  async (ctx) => {
    const baseUrl = ctx.vars.require("BASE_URL");

    const data = await ctx.http
      .get(`${baseUrl}/products/search?q=phone`)
      .json<{ products: { title: string }[] }>();

    ctx.expect(data.products.length).toBeGreaterThan(0);

    const names = data.products.map((p) => p.title);
    ctx.log(`Found ${data.products.length} products matching 'phone'`, names);
  }
);

// ---------------------------------------------------------------------------
// 3. Multi-step builder — Authentication flow
// ---------------------------------------------------------------------------

export const authFlow = test("auth-flow")
  .meta({ name: "Authentication Flow", tags: ["auth"] })
  .step("login", async (ctx) => {
    const baseUrl = ctx.vars.require("BASE_URL");
    const username = ctx.secrets.require("USERNAME");
    const password = ctx.secrets.require("PASSWORD");

    const data = await ctx.http
      .post(`${baseUrl}/auth/login`, {
        json: { username, password, expiresInMins: 1 },
      })
      .json<{
        accessToken: string;
        refreshToken: string;
        username: string;
      }>();

    ctx.expect(data.accessToken).toBeDefined();
    ctx.expect(data.username).toBe(username);

    ctx.log(`Logged in as ${data.username}`);

    return { token: data.accessToken, refreshToken: data.refreshToken };
  })
  .step("get profile", async (ctx, state) => {
    const baseUrl = ctx.vars.require("BASE_URL");

    const data = await ctx.http
      .get(`${baseUrl}/auth/me`, {
        headers: { Authorization: `Bearer ${state.token}` },
      })
      .json<{
        email: string;
        firstName: string;
        lastName: string;
      }>();

    ctx.expect(data.email).toBeDefined();
    ctx.expect(data.firstName).toBeDefined();

    ctx.log(`Profile: ${data.firstName} ${data.lastName} (${data.email})`);

    return state;
  })
  .step("refresh token", async (ctx, state) => {
    const baseUrl = ctx.vars.require("BASE_URL");

    const data = await ctx.http
      .post(`${baseUrl}/auth/refresh`, {
        json: { refreshToken: state.refreshToken, expiresInMins: 1 },
      })
      .json<{ accessToken: string }>();

    ctx.expect(data.accessToken).toBeDefined();

    ctx.log("Token refreshed successfully");
  });

// ---------------------------------------------------------------------------
// 4. Simple test — Cart data integrity
// ---------------------------------------------------------------------------

export const cartIntegrity = test(
  {
    id: "cart-integrity",
    name: "Cart Data Integrity",
    tags: ["data-integrity"],
  },
  async (ctx) => {
    const baseUrl = ctx.vars.require("BASE_URL");

    const cart = await ctx.http.get(`${baseUrl}/carts/1`).json<{
      products: { quantity: number; price: number }[];
      total: number;
      discountedTotal: number;
    }>();

    ctx.expect(cart.products.length).toBeGreaterThan(0);

    // Verify each product has valid data
    for (const p of cart.products.slice(0, 3)) {
      ctx.expect(p.quantity).toBeGreaterThan(0);
      ctx.expect(p.price).toBeGreaterThan(0);
    }

    // Verify discount math
    ctx.assert(
      cart.discountedTotal <= cart.total,
      "Discounted total should be <= total",
      { actual: cart.discountedTotal, expected: `<= ${cart.total}` }
    );

    ctx.log(`Cart has ${cart.products.length} items`);
    ctx.log(`Total: $${cart.total}, After discount: $${cart.discountedTotal}`);
  }
);

// ---------------------------------------------------------------------------
// 5. Simple test — Pagination consistency
// ---------------------------------------------------------------------------

export const paginationCheck = test(
  { id: "pagination-check", name: "Pagination Consistency", tags: ["data"] },
  async (ctx) => {
    const baseUrl = ctx.vars.require("BASE_URL");

    const d1 = await ctx.http
      .get(`${baseUrl}/products?limit=10&skip=0`)
      .json<{ products: unknown[]; total: number; skip: number }>();

    const d2 = await ctx.http
      .get(`${baseUrl}/products?limit=10&skip=10`)
      .json<{ products: unknown[]; total: number; skip: number }>();

    ctx.expect(d1.products.length).toBe(10);
    ctx.expect(d2.skip).toBe(10);
    ctx.assert(
      d2.skip + d2.products.length <= d2.total,
      "skip + length should be <= total",
      { actual: d2.skip + d2.products.length, expected: `<= ${d2.total}` }
    );

    ctx.log(`Page 1: ${d1.products.length} items (skip=0)`);
    ctx.log(`Page 2: ${d2.products.length} items (skip=10)`);
    ctx.log(`Total: ${d2.total}, verified skip + length <= total`);
  }
);

// ---------------------------------------------------------------------------
// 6. Multi-step builder — User-Todos cross-resource integrity
// ---------------------------------------------------------------------------

export const userTodosIntegrity = test("user-todos-integrity")
  .meta({ name: "User Todos Cross-Resource", tags: ["data-integrity"] })
  .step("fetch user", async (ctx) => {
    const baseUrl = ctx.vars.require("BASE_URL");

    const user = await ctx.http
      .get(`${baseUrl}/users/1`)
      .json<{ id: number; firstName: string; lastName: string }>();

    ctx.expect(user.id).toBe(1);
    ctx.log(`User: ${user.firstName} ${user.lastName} (id=${user.id})`);

    return { userId: user.id };
  })
  .step("verify todos", async (ctx, state) => {
    const baseUrl = ctx.vars.require("BASE_URL");

    const data = await ctx.http
      .get(`${baseUrl}/todos?limit=5&skip=0`)
      .json<{ todos: { id: number; todo: string; userId: number }[] }>();

    ctx.expect(data.todos.length).toBeGreaterThan(0);

    // Check that we can find todos for this user
    const userTodos = data.todos.filter((t) => t.userId === state.userId);

    ctx.log(
      `Found ${data.todos.length} todos, ${userTodos.length} belong to user ${state.userId}`
    );

    // Each todo should have required fields
    for (const todo of data.todos.slice(0, 3)) {
      ctx.expect(todo.id).toBeDefined();
      ctx.expect(todo.todo).toBeDefined();
    }
  });
