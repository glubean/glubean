/**
 * Example selection with test.pick — run one example at a time.
 *
 * Unlike test.each (which runs every row), test.pick randomly selects one
 * example from a named map. This is ideal when you have multiple request
 * variations for the same API and want lightweight smoke coverage without
 * running all of them every time.
 *
 * The data inside each example can be anything — query params, JSON body,
 * headers, expected status, or all of the above. You decide the shape.
 *
 * Three patterns are shown:
 *
 * 1. Query-only — different search params for a GET endpoint
 * 2. Body-only — different JSON payloads for a POST endpoint
 * 3. Body + Query — both in one example, loaded from a JSON file
 *
 * In VS Code, CodeLens buttons appear above each test.pick() call,
 * letting you click a specific example to run.
 *
 * Run:      glubean run pick.test.ts
 * Pick one: glubean run pick.test.ts --pick by-category
 * Pick N:   glubean run pick.test.ts --pick normal,edge-case
 */
import { test } from "@glubean/sdk";

// Named examples from JSON — each contains body + query together
import createUserExamples from "./data/create-user.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Pattern 1: Query params — different search variations for GET
// ---------------------------------------------------------------------------

/**
 * Each example defines query params and an expected result.
 * The data shape is entirely up to you — here it's { q, minPrice, expected }.
 *
 * Try:  glubean run pick.test.ts --pick by-category
 */
export const searchProducts = test.pick({
  "by-name": { q: "phone", minPrice: 0, expected: "phone" },
  "by-category": { q: "laptops", minPrice: 500, expected: "laptop" },
  "empty-query": { q: "", minPrice: 0, expected: "" },
})(
  "search-products-$_pick",
  async ({ http, vars, expect, log }, { q, minPrice, expected }) => {
    const baseUrl = vars.require("BASE_URL");

    const res = await http
      .get(`${baseUrl}/products/search`, {
        searchParams: { q, ...(minPrice > 0 && { minPrice }) },
      })
      .json<{ products: { title: string; price: number }[]; total: number }>();

    expect(res.total).toBeType("number");
    if (expected && res.total > 0) {
      expect(res.products[0].title.toLowerCase()).toContain(expected);
      if (minPrice > 0) {
        expect(res.products[0].price).toBeGreaterThan(minPrice);
      }
    }

    log(`Search "${q}" → ${res.total} results`);
  },
);

// ---------------------------------------------------------------------------
// Pattern 2: JSON body — different payloads for POST
// ---------------------------------------------------------------------------

/**
 * Each example is a request body for POST /products/add.
 * Notice: no query params here — examples can be any shape you need.
 *
 * Try:  glubean run pick.test.ts --pick premium
 */
export const addProduct = test.pick({
  "basic": { title: "USB Cable", price: 9.99, category: "accessories" },
  "premium": { title: "Pro Monitor", price: 1299, category: "laptops" },
  "free-tier": { title: "Trial Pack", price: 0, category: "misc" },
})(
  "add-product-$_pick",
  async ({ http, vars, expect, log }, body) => {
    const baseUrl = vars.require("BASE_URL");

    const res = await http
      .post(`${baseUrl}/products/add`, { json: body })
      .json<{ id: number; title: string; price: number }>();

    expect(res.id).toBeDefined();
    expect(res.title).toBe(body.title);
    expect(res.price).toBe(body.price);

    log(`Created product: ${res.title} ($${res.price}) → id ${res.id}`);
  },
);

// ---------------------------------------------------------------------------
// Pattern 3: Body + Query from JSON file — full request variations
// ---------------------------------------------------------------------------

/**
 * Each example in create-user.json contains both `body` and `query`,
 * showing that a single example can carry everything needed for a request.
 * You design the data shape — test.pick just selects which one to run.
 *
 * Try:  glubean run pick.test.ts --pick edge-case
 */
export const createUser = test.pick(createUserExamples)(
  "create-user-$_pick",
  async ({ http, vars, expect, log }, { body, query }) => {
    const baseUrl = vars.require("BASE_URL");

    const res = await http
      .post(`${baseUrl}/users/add`, {
        json: body,
        searchParams: query,
      })
      .json<{ id: number; firstName: string }>();

    expect(res.id).toBeDefined();
    expect(res.firstName).toBe(body.firstName);

    log(`Created user: ${res.firstName || "(empty)"} → id ${res.id}`);
  },
);
