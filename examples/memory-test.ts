/**
 * Example test demonstrating memory monitoring
 */
import { test } from "@glubean/sdk";

export const simpleTest = test("simple-memory-test", async (ctx) => {
  ctx.log("Starting test");

  // Check initial memory
  const before = ctx.getMemoryUsage();
  if (before) {
    ctx.log(`Initial heap: ${(before.heapUsed / 1024 / 1024).toFixed(2)} MB`);
  }

  // Allocate some memory
  const data = new Array(100000).fill("test data");

  // Check memory after allocation
  const after = ctx.getMemoryUsage();
  if (after && before) {
    const delta = (after.heapUsed - before.heapUsed) / 1024 / 1024;
    ctx.log(`Memory delta: ${delta.toFixed(2)} MB`);
  }

  ctx.assert(data.length === 100000, "Array should have correct length");
  ctx.log("Test completed");
});

export const memoryIntensiveTest =
  test("memory-intensive-test", async (ctx) => {
    ctx.log("Starting memory-intensive test");

    const before = ctx.getMemoryUsage();
    if (before) {
      ctx.log(`Initial heap: ${(before.heapUsed / 1024 / 1024).toFixed(2)} MB`);
    }

    // Allocate more memory
    const arrays = [];
    for (let i = 0; i < 10; i++) {
      arrays.push(new Array(100000).fill(`data-${i}`));
    }

    const after = ctx.getMemoryUsage();
    if (after && before) {
      const delta = (after.heapUsed - before.heapUsed) / 1024 / 1024;
      ctx.log(`Memory used: ${delta.toFixed(2)} MB`);
      ctx.log(`Total heap: ${(after.heapUsed / 1024 / 1024).toFixed(2)} MB`);
    }

    ctx.assert(arrays.length === 10, "Should have 10 arrays");
    ctx.log("Test completed");
  });

export const multiStepTest = test("multi-step-memory-test")
  .meta({ tags: ["memory", "multi-step"] })
  .setup(async (ctx) => {
    ctx.log("Setup: Allocating initial data");
    const mem = ctx.getMemoryUsage();
    if (mem) {
      ctx.log(`Setup memory: ${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB`);
    }
    return { data: new Array(50000).fill("setup data") };
  })
  .step("Step 1: Process data", async (ctx, state) => {
    ctx.log("Processing data in step 1");
    const mem = ctx.getMemoryUsage();
    if (mem) {
      ctx.log(`Step 1 memory: ${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB`);
    }
    state.data.push("step1");
    return state;
  })
  .step("Step 2: More processing", async (ctx, state) => {
    ctx.log("Processing data in step 2");
    const mem = ctx.getMemoryUsage();
    if (mem) {
      ctx.log(`Step 2 memory: ${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB`);
    }
    state.data.push("step2");
    return state;
  })
  .teardown(async (ctx, state) => {
    ctx.log("Teardown: Cleaning up");
    const mem = ctx.getMemoryUsage();
    if (mem) {
      ctx.log(`Teardown memory: ${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB`);
    }
    ctx.assert(state.data.length > 50000, "Data should have been modified");
  })
  .build();
