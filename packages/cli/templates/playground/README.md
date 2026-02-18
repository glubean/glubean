# DummyJSON Playground: Learn Glubean with AI

This is a hands-on playground for learning how to use Glubean + AI to write API verification tests.

You will use an AI coding agent (Cursor, Claude Code, Codex, etc.) to write, run, debug, and fix tests against the
[DummyJSON](https://dummyjson.com) API — a free, public REST API with auth, CRUD, pagination, and more.

**No server setup. No API keys. No signup. Just init and go.**

---

## The big picture

Most API tests are written once, run in CI, and forgotten. Glubean is different:

```
Write tests (here, with AI) → Push to git → Glubean runs them continuously
→ Multi-environment (staging, prod) → Alerts when something breaks
```

This playground teaches step 1: writing high-coverage tests efficiently with AI. Once your tests are green, a single
`git push` turns them into a continuous verification pipeline — scheduled runs, environment management, Slack alerts,
and a dashboard with full assertion/trace history. No rewrites needed.

**The tests you write in this playground are the same tests that run in production monitoring.** That's the point.

---

## What you will learn

By the end of this playground, you will know how to:

1. Use the Glubean SDK to write API verification tests
2. Use AI to generate tests from an API reference
3. Use the **run → fail → diagnose → fix → rerun** closed loop
4. Understand why giving AI good API context matters (and how much faster it makes things)
5. See how these tests become continuous verification after `git push`

---

## Prerequisites

- [Deno](https://deno.land) installed (`brew install deno` on macOS)
- An AI coding agent (Cursor, Claude Code, Windsurf, Codex, etc.)
- 30 minutes of curiosity

---

## Setup (2 minutes)

### 1. Verify it works

```bash
deno task test
```

You should see output like:

```
🧪 Glubean Test Runner

  ● DummyJSON API is reachable [smoke]
    ✓ PASSED (629ms)

Tests: 1 passed
```

If you see this, you're ready to go.

> **Running other test files:** As you create new test files during the exercises, run them with:
>
> ```bash
> deno run -A jsr:@glubean/cli run ./YOUR_FILE.test.ts --verbose
> ```

### 2. Set up secrets for auth exercises

```bash
cp .env.secrets.example .env.secrets
```

The example file has DummyJSON's built-in test credentials pre-filled. No changes needed.

### 3. (Optional) Set up Glubean MCP in Cursor

This enables the full closed loop: AI writes tests, runs them via MCP, reads structured failures, and fixes
automatically.

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

Restart Cursor. The MCP tools (`glubean_discover_tests`, `glubean_run_local_file`) will now be available to your AI
agent.

> **Without MCP?** No problem. All exercises work with manual `deno task test` too. MCP just automates the run-and-fix
> loop.

---

## How this playground works

There are **9 exercises**, designed in 3 tiers:

| Tier                        | Exercises      | Purpose                                                       |
| --------------------------- | -------------- | ------------------------------------------------------------- |
| **Tier 1: Fly blind**       | #1, #2         | AI has no API docs. You see how it guesses and fails.         |
| **Tier 2: With context**    | #3, #4, #5     | AI gets `@API_REFERENCE.md`. You see the dramatic difference. |
| **Tier 3: Real challenges** | #6, #7, #8, #9 | Even with docs, verification logic is inherently tricky.      |

**The key insight:** Tier 1 → Tier 2 is where the "aha" moment happens. Same task, with and without API context, and
you'll see AI go from 4-5 failure cycles to 1-2.

For each exercise, you **copy the prompt into your AI agent** and watch what happens. Then you observe, learn, and move
on.

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

After writing, run `deno task test` and fix any failures.
```

**What to observe:**

- AI should get this mostly right on the first try (simple GETs, no auth)
- Look at how AI uses `ctx.expect()` (fluent assertions), `ctx.trace()`, `ctx.log()`
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

Use the builder API: test("auth-flow").setup(...).step(...)
Store credentials in .env.secrets and read via ctx.secrets.require().

After writing, run `deno task test` and fix any failures.
```

**What to observe:**

- AI doesn't know the exact endpoint paths (`/auth/login`? `/user/login`? `/login`?)
- AI doesn't know the request body shape (`username`? `email`? `user`?)
- AI doesn't know the response shape (where is `accessToken`? nested or top-level?)
- AI might forget to create `.env.secrets`

**Expected:** 3-5 rounds of run → fail → fix. **This is the point.** Watch how each structured failure
(`{ actual: 404, expected: 200 }`) gives AI enough information to correct itself.

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

Use the builder API: test("auth-flow").setup(...).step(...)
Store credentials in .env.secrets and read via ctx.secrets.require().
Use ctx.trace() with a name field for each API call.

After writing, run `deno task test` and fix any failures.
```

**What to observe:**

- AI gets endpoint paths right immediately
- AI gets request/response shapes right
- The only likely failure: `.env.secrets` not configured yet → AI diagnoses and tells you to create it
- **1-2 rounds** vs 3-5 in Exercise 2

**The lesson:** API context is the biggest lever for AI-assisted test generation. When you apply Glubean to your own
APIs, write an `API_REFERENCE.md` (or use your OpenAPI spec). It pays for itself immediately.

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

After writing, run `deno task test` and fix any failures.
```

**What to observe:**

- Sort verification requires iterating arrays and comparing neighbors — AI sometimes gets the loop logic wrong on first
  try
- The `select` test: DummyJSON always includes `id` even if not requested. AI may assert that only `title` and `price`
  exist, then fail because `id` is there too. Watch how it adapts.

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

After writing, run `deno task test` and fix any failures.
```

**What to observe:**

- DummyJSON has real floating point precision issues (`total: 124.94999999999999`)
- AI's first attempt will likely use strict `===` equality — and fail
- The structured failure shows exactly what's off (`actual: 124.949...`, `expected: 124.95`)
- AI learns to use tolerance-based comparison

**The lesson:** This is why "verification-as-code" matters. These aren't bugs in your code — they're properties you need
to continuously prove. And even with perfect docs, the verification logic itself requires iteration.

---

### Pause: what happens after `git push`?

You've now written 5 test files. They work locally. Here's what happens when you push them to a Glubean-connected repo:

1. **Automatic bundle build** — Glubean detects the push, scans your test files, and creates an immutable bundle (like a
   Docker image for your tests).

2. **One-click scheduling** — In the dashboard, bind your tests to an environment (staging, production) and set a
   schedule: every 5 minutes, every hour, daily at 3am.

3. **Multi-environment execution** — The same `cart-math.test.ts` you just wrote runs against staging AND production
   with different `BASE_URL` values. No code changes.

4. **Structured results** — Every assertion, trace, and log you wrote with `ctx.expect()`, `ctx.trace()`, and
   `ctx.log()` becomes searchable history in the dashboard — not buried terminal output.

5. **Alerts** — When the API team changes a response shape and your test fails at 3am, your Slack channel gets a
   notification with the exact assertion that broke: `expected 200, got 502`.

**You don't need to rewrite anything.** The tests you're writing right now are production-grade verification code.
That's the Glubean model: author locally with AI, run continuously in the cloud.

OK, back to the exercises.

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

Use test<State>("product-crud").setup(...).step(...)
Use ctx.trace() with descriptive names for every API call.

After writing, run `deno task test` and fix any failures.
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

After writing, run `deno task test` and fix any failures.
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

After writing, run `deno task test` and fix any failures.
```

**What to observe:**

- `ctx.setTimeout()` and `ctx.skip()` are rarely covered by AI on its own
- The timing assertion introduces the concept of performance verification
- `ctx.skip()` demonstrates feature-flagging for tests — useful in real CI/CD

---

### Exercise 9: Data-driven tests

**Goal:** Learn to generate many tests from external data files. One data row = one independent test.

First, create the data files:

**`data/categories.json`:**

```json
[
  { "slug": "smartphones", "minProducts": 1 },
  { "slug": "laptops", "minProducts": 1 },
  { "slug": "fragrances", "minProducts": 1 },
  { "slug": "groceries", "minProducts": 1 }
]
```

**`data/search-terms.csv`:**

```csv
term,minResults
phone,1
laptop,1
zzzznotreal,0
```

Now copy this prompt into your AI agent:

```
Refer to @API_REFERENCE.md for the DummyJSON API documentation.

I'm using the Glubean SDK to write data-driven API verification tests.

Write a file `data-driven.test.ts` that:

1. Imports data/categories.json using native `import ... with { type: "json" }`.
   Use `test.each(categories)` to generate one test per category:
   - GET /products/category/{slug}
   - Assert status 200
   - Assert products.length >= minProducts
   - Use tagFields: "slug" to auto-tag each test (e.g. "slug:smartphones")

2. Loads data/search-terms.csv using `fromCsv("./data/search-terms.csv")`.
   Use `test.each(data)` to generate one test per search term:
   - GET /products/search?q={term}
   - Assert status 200
   - If minResults > 0, assert products array is non-empty
   - If minResults === 0, assert products array is empty (or very small)
   - Use filter to skip rows where term is empty

Use `import { test, fromCsv } from "@glubean/sdk"`.
Read BASE_URL from ctx.vars.require("BASE_URL").
Use ctx.log() to report counts and results.

After writing, run the tests and fix any failures.
Then try: glubean run data-driven.test.ts --tag slug:smartphones
to run only smartphone category tests.
```

**What to observe:**

- `test.each` generates N independent tests from N rows — each has its own ID, tags, and pass/fail
- `tagFields` auto-generates tags like `"slug:smartphones"` for runtime filtering
- `fromCsv` values are all strings — AI needs to cast `Number(minResults)` for comparison
- `--tag slug:smartphones` runs only matching tests without changing code

---

## After the exercises

You've now experienced the complete Glubean local development loop:

```
Write test → Run → See structured failure → Fix → Rerun → Green ✓
```

And you've learned the key patterns:

| Pattern                                            | What you learned              | Exercise |
| -------------------------------------------------- | ----------------------------- | -------- |
| `ctx.vars.require()` / `ctx.secrets.require()`     | Safe env/secret access        | #2, #3   |
| `ctx.expect(val).toBe(expected)`                   | Fluent soft-by-default checks | All      |
| `ctx.expect(val).toBe(x).orFail()`                 | Guard — abort if critical     | #6       |
| `ctx.assert(condition, msg, { actual, expected })` | Low-level assertions          | All      |
| `ctx.warn(cond, msg)`                              | Non-failing best-practice     | #8       |
| `ctx.validate(data, schema)`                       | Schema validation             | —        |
| `ctx.trace({ method, url, status, duration })`     | API call recording            | All      |
| `ctx.log(msg, data)`                               | Structured logging            | All      |
| `test("id").setup().step()`                        | Multi-step stateful tests     | #5, #6   |
| `ctx.skip(reason)` / `ctx.setTimeout(ms)`          | Conditional and resilience    | #8       |
| `test.each(data)` / `fromCsv` / `tagFields`        | Data-driven test generation   | #9       |
| `@API_REFERENCE.md`                                | Giving AI the right context   | #3 vs #2 |

---

## From local tests to continuous verification

You've been running tests locally. Here's what the full workflow looks like when you apply this to your own API:

### Step 1: Create a real project

```bash
glubean init
# → generates project scaffold with AGENTS.md, .env, deno.json
```

### Step 2: Write tests with AI

```
Refer to @API_REFERENCE.md. Write Glubean tests for the /users endpoint.
```

Same patterns you just learned. Same SDK. Same AI workflow.

### Step 3: Push to git

```bash
git add . && git commit -m "add api tests" && git push
```

Glubean automatically builds a bundle from your test files — like a Docker image for your verification suite.

### Step 4: The cloud takes over

This is where Glubean diverges from every other test framework:

| What you configure once                 | What happens automatically                                        |
| --------------------------------------- | ----------------------------------------------------------------- |
| Environment groups (staging, prod)      | Same tests run against each with different `BASE_URL` and secrets |
| Schedule (every 5 min / hourly / daily) | Workers pick up runs from a queue — no cron jobs to maintain      |
| Alert channels (Slack, email, webhook)  | Failures notify your team with the exact assertion that broke     |

Your `cart-math.test.ts` that checks floating-point totals? It now runs against production every hour. When the payments
team changes rounding logic, you know in minutes — not when a customer complains.

### Step 5: Iterate

```
Push code → Bundle auto-builds → Next scheduled run picks it up
```

No redeploy. No restart. No config change. Just push.

### The mental model

```
Traditional:  write test → run in CI → forget → break silently → find out later
Glubean:      write test → run locally → push → runs forever → alerts on failure
```

The tests you wrote in this playground are not throwaway exercises. They are the exact same format that runs in
production monitoring. The SDK is the authoring layer. The cloud is the execution layer. `git push` is the bridge.

---

**Learn more:**

- [Glubean SDK on JSR](https://jsr.io/@glubean/sdk)
- [Glubean CLI on JSR](https://jsr.io/@glubean/cli)
