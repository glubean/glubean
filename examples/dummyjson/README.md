# DummyJSON Playground: Learn Glubean with AI

This is a hands-on playground for learning how to use Glubean + AI to write API verification tests.

You will use an AI coding agent (Cursor, Claude Code, Codex, etc.) to write, run, debug, and fix tests against the [DummyJSON](https://dummyjson.com) API — a free, public REST API with auth, CRUD, pagination, and more.

**No server setup. No API keys. No signup. Just clone and go.**

---

## What you will learn

By the end of this playground, you will know how to:

1. Use the Glubean SDK to write API verification tests
2. Use AI to generate tests from an API reference
3. Use the **run → fail → diagnose → fix → rerun** closed loop
4. Understand why giving AI good API context matters (and how much faster it makes things)

---

## Prerequisites

- [Deno](https://deno.land) installed (`brew install deno` on macOS)
- An AI coding agent (Cursor, Claude Code, Windsurf, Codex, etc.)
- 30 minutes of curiosity

---

## Setup (2 minutes)

### 1. Navigate to the repo root

```bash
cd /path/to/glubean
```

### 2. Verify it works

```bash
deno task dummyjson
```

You should see output like:

```
🧪 Glubean Test Runner

  ● DummyJSON API is reachable [smoke]
    ✓ PASSED (629ms)

Tests: 1 passed
```

If you see this, you're ready to go.

> **Note:** All commands run from the repo root. When running test files directly, pass the env file:
>
> ```bash
> deno run -A ./packages/cli/mod.ts run ./examples/dummyjson/YOUR_FILE.test.ts \
>   --env-file ./examples/dummyjson/.env
> ```

### 3. (Optional) Set up Glubean MCP in Cursor

This enables the full closed loop: AI writes tests, runs them via MCP, reads structured failures, and fixes automatically.

Add to your Cursor MCP settings (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "glubean": {
      "command": "deno",
      "args": ["run", "-A", "jsr:@glubean/mcp"]
    }
  }
}
```

Restart Cursor. The MCP tools (`glubean_discover_tests`, `glubean_run_local_file`) will now be available to your AI agent.

> **Without MCP?** No problem. All exercises work with manual `deno task test` too. MCP just automates the run-and-fix loop.

---

## How this playground works

There are **8 exercises**, designed in 3 tiers:

| Tier                        | Exercises  | Purpose                                                       |
| --------------------------- | ---------- | ------------------------------------------------------------- |
| **Tier 1: Fly blind**       | #1, #2     | AI has no API docs. You see how it guesses and fails.         |
| **Tier 2: With context**    | #3, #4, #5 | AI gets `@API_REFERENCE.md`. You see the dramatic difference. |
| **Tier 3: Real challenges** | #6, #7, #8 | Even with docs, verification logic is inherently tricky.      |

**The key insight:** Tier 1 → Tier 2 is where the "aha" moment happens. Same task, with and without API context, and you'll see AI go from 4-5 failure cycles to 1-2.

For each exercise, you **copy the prompt into your AI agent** and watch what happens. Then you observe, learn, and move on.

---

## Exercises

### Exercise 1: Hello Products (warm-up)

**Goal:** Get your first test passing. Learn the basic SDK pattern.

**Copy this prompt into your AI agent:**

```
I'm using the Glubean SDK to write API verification tests.
The target API is DummyJSON at https://dummyjson.com.

Write a file `products.test.ts` in the current directory that:
1. Lists all products (GET /products) and asserts status 200 and non-empty array
2. Gets a single product by ID and asserts it has id, title, price, and rating fields
3. Searches products with GET /products/search?q=phone and asserts results are relevant

Use `import { test } from "@glubean/sdk"`.
Read BASE_URL from ctx.vars.require("BASE_URL").
Use ctx.trace() to record each API call.
Use ctx.log() to report what you find.

After writing, run the tests and fix any failures.
```

**What to observe:**

- AI should get this mostly right on the first try (simple GETs, no auth)
- Look at how AI uses `ctx.assert()`, `ctx.trace()`, `ctx.log()`
- This is the baseline SDK pattern you'll use everywhere

---

### Exercise 2: Auth flow — without docs

**Goal:** Experience the AI closed loop. Watch AI fail and self-correct.

**Copy this prompt into your AI agent:**

```
I'm using the Glubean SDK to write API verification tests.
The target API is DummyJSON at https://dummyjson.com.

Write a file `auth.test.ts` that verifies the authentication flow:
1. Login with valid credentials and get tokens
2. Use the token to access a protected user profile endpoint
3. Refresh the token and verify new tokens are returned

Use the builder API: test("auth-flow").setup(...).step(...).build()
Store credentials in .env.secrets and read via ctx.secrets.require().

After writing, run the tests and fix any failures.
```

**What to observe:**

- AI doesn't know the exact endpoint paths (`/auth/login`? `/user/login`? `/login`?)
- AI doesn't know the request body shape (`username`? `email`? `user`?)
- AI doesn't know the response shape (where is `accessToken`? nested or top-level?)
- AI might forget to create `.env.secrets`

**Expected:** 3-5 rounds of run → fail → fix. **This is the point.** Watch how each structured failure (`{ actual: 404, expected: 200 }`) gives AI enough information to correct itself.

---

### Exercise 3: Auth flow — with docs (the "aha" moment)

**Goal:** Same task as Exercise 2, but now AI has the API reference. Compare the experience.

**Copy this prompt into your AI agent:**

```
Refer to @API_REFERENCE.md for the DummyJSON API documentation.

I'm using the Glubean SDK to write API verification tests.

Rewrite `auth.test.ts` to verify the authentication flow:
1. Login with test credentials via POST /auth/login
2. Access the authenticated user profile via GET /auth/me with Bearer token
3. Refresh the token via POST /auth/refresh

Use the builder API: test("auth-flow").setup(...).step(...).build()
Store credentials in .env.secrets and read via ctx.secrets.require().
Use ctx.trace() with a name field for each API call.

After writing, run the tests and fix any failures.
```

**What to observe:**

- AI gets endpoint paths right immediately
- AI gets request/response shapes right
- The only likely failure: `.env.secrets` not configured yet → AI diagnoses and tells you to create it
- **1-2 rounds** vs 3-5 in Exercise 2

**The lesson:** API context is the biggest lever for AI-assisted test generation. When you apply Glubean to your own APIs, write an `API_REFERENCE.md` (or use your OpenAPI spec). It pays for itself immediately.

---

### Exercise 4: Pagination, sort, and field selection

**Goal:** Learn how AI handles data validation assertions.

```
Refer to @API_REFERENCE.md for the DummyJSON API documentation.

Write a file `pagination.test.ts` that verifies:

1. Pagination: GET /products?limit=10&skip=10
   - Should return exactly 10 items
   - Response `skip` should equal 10
   - Verify: skip + products.length <= total

2. Sort ascending: GET /products?sortBy=price&order=asc
   - Every product price should be >= the previous product's price

3. Sort descending: GET /products?sortBy=price&order=desc
   - Every product price should be <= the previous product's price

4. Field selection: GET /products?select=title,price&limit=5
   - Each product should have only id, title, and price (no other keys)

Use ctx.assert() with actual/expected details for every comparison.
Log the actual values so failures are easy to diagnose.

After writing, run the tests and fix any failures.
```

**What to observe:**

- Sort verification requires iterating arrays and comparing neighbors — AI sometimes gets the loop logic wrong on first try
- The `select` test: DummyJSON always includes `id` even if not requested. AI may assert that only `title` and `price` exist, then fail because `id` is there too. Watch how it adapts.

---

### Exercise 5: Cart math — floating point fun

**Goal:** Encounter a real-world verification challenge that docs alone can't solve.

```
Refer to @API_REFERENCE.md for the DummyJSON API documentation.

Write a file `cart-math.test.ts` that verifies cart calculations:

1. Get cart (GET /carts/1) and for each product in the cart, verify:
   - product.total should equal product.price * product.quantity
   - product.discountedTotal should be approximately
     product.total * (1 - product.discountPercentage / 100)

2. Verify cart-level totals:
   - cart.total should equal the sum of all product.total values
   - cart.discountedTotal should equal the sum of all product.discountedTotal values

3. Basic sanity: cart.discountedTotal should be <= cart.total

Use tolerance for floating point comparisons (Math.abs(a - b) < 0.01).
Log discrepancies with actual values for debugging.

After writing, run the tests and fix any failures.
```

**What to observe:**

- DummyJSON has real floating point precision issues (`total: 124.94999999999999`)
- AI's first attempt will likely use strict `===` equality — and fail
- The structured failure shows exactly what's off (`actual: 124.949...`, `expected: 124.95`)
- AI learns to use tolerance-based comparison

**The lesson:** This is why "verification-as-code" matters. These aren't bugs in your code — they're properties you need to continuously prove. And even with perfect docs, the verification logic itself requires iteration.

---

### Exercise 6: CRUD lifecycle with state

**Goal:** Learn the builder API's state management with a multi-step flow.

```
Refer to @API_REFERENCE.md for the DummyJSON API documentation.

Write a file `crud.test.ts` with a multi-step product lifecycle test:

Setup: no special setup needed

Step 1: "Create product"
  - POST /products/add with title, price, category
  - Assert response has id
  - Store the new product id in state

Step 2: "Read product"
  - GET /products/{id} (use the original id=1, since DummyJSON doesn't persist)
  - Assert all expected fields exist

Step 3: "Update product"
  - PUT /products/1 with a new title
  - Assert the returned product has the updated title

Step 4: "Delete product"
  - DELETE /products/1
  - Assert response has isDeleted: true
  - Assert deletedOn is a valid ISO 8601 date string

Use test<State>("product-crud").setup(...).step(...).build()
Use ctx.trace() with descriptive names for every API call.

After writing, run the tests and fix any failures.
```

**What to observe:**

- AI needs to handle the fact that DummyJSON CRUD is simulated (create returns id: 195, but you can't GET /products/195)
- The ISO date validation for `deletedOn` is a fun assertion challenge
- State flows naturally through the builder API steps

---

### Exercise 7: Cross-resource data integrity

**Goal:** Learn to verify data relationships across multiple API calls.

```
Refer to @API_REFERENCE.md for the DummyJSON API documentation.

Write a file `integrity.test.ts` that verifies data consistency:

1. "User's todos belong to user"
   - GET /users/1/todos
   - Assert every todo.userId === 1

2. "Product categories are consistent"
   - GET /products/categories → get list of category slugs
   - Pick the first category slug
   - GET /products/category/{slug}
   - Assert every returned product.category === slug

3. "Recipe tags are consistent"
   - GET /recipes/tags → get tag list
   - Pick the first tag
   - GET /recipes/tag/{tag}
   - Assert every returned recipe.tags array includes the queried tag

4. "Cart product prices match catalog"
   - GET /carts/1 → get first product from cart
   - GET /products/{productId}
   - Assert cart item price matches catalog price

Use ctx.log() to report what you're checking at each step.
Trace every API call.

After writing, run the tests and fix any failures.
```

**What to observe:**

- This is the essence of **verification-as-code**: proving relationships hold across a system
- These tests catch "integration drift" — when one service changes and another doesn't
- AI might get tripped up by array `.includes()` for case-sensitive tag matching

---

### Exercise 8: Resilience and conditional tests

**Goal:** Learn timeout handling, conditional skip, and performance SLA verification.

```
Refer to @API_REFERENCE.md for the DummyJSON API documentation.

Write a file `resilience.test.ts` that tests API resilience:

1. "Slow response handling"
   - GET /products?delay=3000 (simulates 3s latency)
   - Use ctx.setTimeout(10000) to allow enough time
   - Measure actual duration and assert it's >= 3000ms
   - Assert the response is still valid

2. "Response time SLA"
   - GET /products/1 (no delay)
   - Assert response time < 2000ms
   - Use ctx.trace() to record the timing

3. "Conditional skip"
   - Check ctx.vars.get("RUN_SLOW_TESTS")
   - If not set, call ctx.skip("RUN_SLOW_TESTS not enabled")
   - If set, run the slow response test again

After writing, run the tests and fix any failures.
```

**What to observe:**

- `ctx.setTimeout()` and `ctx.skip()` are rarely covered by AI on its own
- The timing assertion introduces the concept of performance verification
- `ctx.skip()` demonstrates feature-flagging for tests — useful in real CI/CD

---

## After the exercises

You've now experienced the complete Glubean local development loop:

```
Write test → Run → See structured failure → Fix → Rerun → Green ✓
```

And you've learned the key patterns:

| Pattern                                            | What you learned             | Exercise |
| -------------------------------------------------- | ---------------------------- | -------- |
| `ctx.vars.require()` / `ctx.secrets.require()`     | Safe env/secret access       | #2, #3   |
| `ctx.assert(condition, msg, { actual, expected })` | Structured assertions for AI | All      |
| `ctx.trace({ method, url, status, duration })`     | API call recording           | All      |
| `ctx.log(msg, data)`                               | Structured logging           | All      |
| `test("id").setup().step().build()`                | Multi-step stateful tests    | #5, #6   |
| `ctx.skip(reason)` / `ctx.setTimeout(ms)`          | Conditional and resilience   | #8       |
| `@API_REFERENCE.md`                                | Giving AI the right context  | #3 vs #2 |

### What's next?

**Apply this to your own API:**

1. Write an `API_REFERENCE.md` for your API (or use your OpenAPI spec)
2. Create a project: `glubean init`
3. Ask your AI: "Refer to @API_REFERENCE.md. Write Glubean tests for the /users endpoint."
4. Run → Fix → Iterate
5. When tests are green, push to git and sync to Glubean Cloud for scheduling and monitoring

**Learn more:**

- [Glubean SDK Reference](../../packages/sdk/README.md)
- [MCP Workflow (AI closed loop)](../../docs/WORKFLOW_AI_MCP.md)
- [Local Development Workflow](../../docs/WORKFLOW_LOCAL_DEV.md)
