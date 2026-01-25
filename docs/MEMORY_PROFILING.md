# Memory Profiling Guide

Glubean provides built-in memory monitoring and profiling capabilities to help you understand and optimize your test resource usage.

## Features

- **Automatic Memory Tracking**: Peak memory usage is automatically tracked for every test
- **Manual Memory Inspection**: Use `ctx.getMemoryUsage()` to check memory at any point
- **Memory Delta Tracking**: Compare memory before and after operations
- **Tier Recommendations**: Understand which tier your tests fit into

## Automatic Memory Reporting

Every test automatically reports peak memory usage:

```bash
$ glubean run tests/api.test.ts

  ● test_create_user
    ✓ PASSED (234ms, 12.5 MB)

  ● test_list_users
    ✓ PASSED (156ms, 8.3 MB)
```

The memory value shown is the **peak heap usage** during test execution.

## Manual Memory Inspection

Use `ctx.getMemoryUsage()` to inspect memory at any point in your test:

```typescript
import { test } from "@glubean/sdk";

export const myTest = test("memory-check", async (ctx) => {
  // Check initial memory
  const before = ctx.getMemoryUsage();
  if (before) {
    ctx.log(`Initial heap: ${(before.heapUsed / 1024 / 1024).toFixed(2)} MB`);
  }

  // Perform memory-intensive operation
  const data = await loadLargeDataset();

  // Check memory after operation
  const after = ctx.getMemoryUsage();
  if (after && before) {
    const delta = (after.heapUsed - before.heapUsed) / 1024 / 1024;
    ctx.log(`Memory used: ${delta.toFixed(2)} MB`);
  }
});
```

### Memory Usage Object

`ctx.getMemoryUsage()` returns an object with the following properties:

```typescript
{
  heapUsed: number; // Heap memory currently used (bytes)
  heapTotal: number; // Total heap memory allocated (bytes)
  external: number; // Memory used by C++ objects bound to JS (bytes)
  rss: number; // Resident set size - total memory for process (bytes)
}
```

Returns `null` if not running in Deno environment.

## Memory Profiling Examples

### Example 1: Track Memory Delta

```typescript
export const dataProcessing = test("process-data", async (ctx) => {
  const before = ctx.getMemoryUsage();

  // Load and process data
  const users = await ctx.fetch("/api/users");
  const processed = users.map((u) => transformUser(u));

  const after = ctx.getMemoryUsage();
  if (before && after) {
    const delta = (after.heapUsed - before.heapUsed) / 1024 / 1024;
    ctx.log(`Processing used ${delta.toFixed(2)} MB`);

    // Assert memory usage is reasonable
    ctx.assert(delta < 50, "Should use less than 50 MB", {
      actual: delta,
      expected: "< 50",
    });
  }
});
```

### Example 2: Multi-Step Memory Tracking

```typescript
export const checkout = test("checkout-flow")
  .setup(async (ctx) => {
    const mem = ctx.getMemoryUsage();
    if (mem) {
      ctx.log(`Setup memory: ${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB`);
    }
    return { cart: await createCart() };
  })
  .step("Add items", async (ctx, state) => {
    await addItem(state.cart, "item-1");
    const mem = ctx.getMemoryUsage();
    if (mem) {
      ctx.log(`After add: ${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB`);
    }
    return state;
  })
  .step("Checkout", async (ctx, state) => {
    await checkout(state.cart);
    const mem = ctx.getMemoryUsage();
    if (mem) {
      ctx.log(`After checkout: ${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB`);
    }
    return state;
  })
  .build();
```

### Example 3: Detect Memory Leaks

```typescript
export const leakDetection = test("detect-leaks", async (ctx) => {
  const samples = [];

  // Take multiple memory samples
  for (let i = 0; i < 5; i++) {
    await performOperation();

    const mem = ctx.getMemoryUsage();
    if (mem) {
      samples.push(mem.heapUsed);
      ctx.log(`Sample ${i + 1}: ${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB`);
    }
  }

  // Check if memory is growing linearly (potential leak)
  if (samples.length >= 5) {
    const growth = samples[4] - samples[0];
    const growthMB = growth / 1024 / 1024;

    ctx.log(`Total growth: ${growthMB.toFixed(2)} MB`);
    ctx.assert(growthMB < 10, "Memory growth should be < 10 MB", {
      actual: growthMB,
      expected: "< 10",
    });
  }
});
```

## Understanding Memory Tiers

Based on your test's peak memory usage, you can determine which Glubean tier is appropriate:

| Tier           | Memory Limit | Best For                                 |
| -------------- | ------------ | ---------------------------------------- |
| **Free**       | 100 MB       | Simple API tests, < 10 requests per test |
| **Pro**        | 512 MB       | Complex workflows, data processing       |
| **Enterprise** | 1 GB+        | Heavy data loads, large response bodies  |

### Optimization Tips

If your tests are using too much memory:

1. **Avoid loading large datasets**: Use pagination or filtering
2. **Clear references**: Set large objects to `null` when done
3. **Stream data**: Process data in chunks instead of loading all at once
4. **Limit response bodies**: Only fetch fields you need

```typescript
// ❌ Bad: Loads entire user list
const users = await ctx.fetch("/api/users");

// ✅ Good: Paginate and process in chunks
const page1 = await ctx.fetch("/api/users?page=1&limit=100");
```

## Memory Monitoring in CI/CD

You can track memory usage trends over time:

```bash
# Run tests and save log
glubean run tests/api.test.ts --log-file

# Parse log for memory metrics
grep "PASSED" api.test.log | grep -oE '[0-9]+\.[0-9]+ MB'
```

Example GitHub Actions workflow:

```yaml
- name: Run tests with memory profiling
  run: |
    glubean run tests/api.test.ts --log-file

- name: Check memory usage
  run: |
    # Extract peak memory from log
    PEAK_MEM=$(grep -oE '[0-9]+\.[0-9]+ MB' api.test.log | sort -n | tail -1)
    echo "Peak memory: $PEAK_MEM"

    # Fail if over threshold
    if (( $(echo "$PEAK_MEM > 100" | bc -l) )); then
      echo "Error: Memory usage exceeded 100 MB"
      exit 1
    fi
```

## Troubleshooting

### Memory not reported

If you don't see memory values:

1. Make sure you're using Deno runtime (not Node.js)
2. Update to latest `@glubean/runner` version
3. Check that `Deno.memoryUsage()` is available in your environment

### Memory values seem incorrect

Memory reporting shows **heap usage**, not total process memory:

- `heapUsed`: JavaScript heap (what your code uses)
- `rss`: Total process memory (includes V8 overhead, etc.)

For profiling purposes, focus on `heapUsed` as it reflects your test's actual memory consumption.

### Memory keeps growing

This might indicate a memory leak:

1. Check for global variables or closures holding references
2. Ensure you're not accumulating data in arrays/objects
3. Use the leak detection pattern shown above
4. Consider using WeakMap/WeakSet for caches

## Best Practices

1. **Profile locally first**: Run tests locally to understand memory usage before deploying
2. **Set memory assertions**: Add assertions to catch memory regressions
3. **Monitor trends**: Track memory usage over time in CI/CD
4. **Optimize hot paths**: Focus on tests that run frequently
5. **Document expectations**: Add comments explaining expected memory usage

## Related

- [Runner Documentation](../packages/runner/README.md)
- [SDK API Reference](../packages/sdk/README.md)
- [Worker Configuration](../packages/worker/README.md)
