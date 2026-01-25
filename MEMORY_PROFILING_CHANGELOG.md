# Memory Profiling Feature - Changelog

## Summary

Added comprehensive memory profiling capabilities to help users understand and optimize their test resource usage.

## Changes

### 1. Runner (`@glubean/runner`)

**File: `packages/runner/harness.ts`**

- Added `startMemoryMonitoring()` function to track memory usage every 100ms
- Added `stopMemoryMonitoring()` function to stop tracking and return peak usage
- Modified `executeStandaloneTest()` to wrap test execution with memory monitoring
- Modified `executeNewTest()` to wrap test execution with memory monitoring
- Modified `executeSuiteTest()` to wrap test execution with memory monitoring
- All test executions now emit `peakMemoryBytes` and `peakMemoryMB` in status events

**File: `packages/runner/executor.ts`**

- Updated `ExecutionEvent` type to include `peakMemoryBytes` and `peakMemoryMB` in status events
- Updated `ExecutionResult` interface to include `peakMemoryBytes` and `peakMemoryMB` fields
- Modified `execute()` method to capture and return memory metrics from status events

### 2. SDK (`@glubean/sdk`)

**File: `packages/sdk/types.ts`**

- Added `getMemoryUsage()` method to `TestContext` interface
- Returns memory stats object with `heapUsed`, `heapTotal`, `external`, and `rss` fields
- Returns `null` if not running in Deno environment
- Comprehensive JSDoc with examples for tracking memory deltas

**File: `packages/sdk/README.md`**

- Added memory profiling section with examples
- Updated quick start to show memory output
- Added link to detailed memory profiling guide

### 3. CLI (`@glubean/cli`)

**File: `packages/cli/commands/run.ts`**

- Modified `runCommand()` to capture `peakMemoryMB` from status events
- Updated console output to display memory usage: `(123ms, 8.5 MB)`
- Updated log file output to include memory metrics in result entries

### 4. Documentation

**New File: `docs/MEMORY_PROFILING.md`**

- Comprehensive guide on memory profiling features
- Examples for automatic and manual memory tracking
- Memory delta tracking patterns
- Multi-step memory monitoring examples
- Memory leak detection patterns
- Tier recommendations based on memory usage
- Optimization tips and best practices
- CI/CD integration examples
- Troubleshooting guide

**New File: `examples/memory-test.ts`**

- Example tests demonstrating memory profiling features
- Simple memory test with delta tracking
- Memory-intensive test with multiple allocations
- Multi-step test with memory tracking at each step

## API Changes

### New TestContext Method

```typescript
interface TestContext {
  // ... existing methods

  getMemoryUsage(): {
    heapUsed: number;
    heapTotal: number;
    external: number;
    rss: number;
  } | null;
}
```

### Updated ExecutionResult

```typescript
interface ExecutionResult {
  // ... existing fields

  peakMemoryBytes?: number;
  peakMemoryMB?: string;
}
```

### Updated ExecutionEvent

```typescript
type ExecutionEvent =
  // ... other event types
  {
    type: "status";
    status: "completed" | "failed" | "skipped";
    // ... other fields
    peakMemoryBytes?: number;
    peakMemoryMB?: string;
  };
```

## User-Facing Changes

### CLI Output

**Before:**

```
  ● test_create_user
    ✓ PASSED (234ms)
```

**After:**

```
  ● test_create_user
    ✓ PASSED (234ms, 12.5 MB)
```

### Test Code

Users can now check memory usage in their tests:

```typescript
export const myTest = test("memory-check", async (ctx) => {
  const mem = ctx.getMemoryUsage();
  if (mem) {
    ctx.log(`Heap: ${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB`);
  }
});
```

## Backward Compatibility

✅ **Fully backward compatible**

- All changes are additive (new fields, new methods)
- Existing tests continue to work without modification
- Memory profiling is automatic and non-intrusive
- `getMemoryUsage()` returns `null` in non-Deno environments

## Testing

Tested with example file `examples/memory-test.ts`:

```bash
$ deno run -A packages/cli/mod.ts run examples/memory-test.ts

  ● memory-intensive-test
    ✓ PASSED (40ms, 6.22 MB)

  ● multi-step-memory-test
    ✓ PASSED (29ms, 6.22 MB)

  ● simple-memory-test
    ✓ PASSED (25ms, 6.22 MB)
```

All tests pass with memory metrics correctly reported.

## Benefits

1. **Local Profiling**: Users can profile memory usage before deploying to cloud
2. **Optimization**: Identify memory-heavy tests and optimize them
3. **Tier Selection**: Understand which Glubean tier fits their needs
4. **Regression Detection**: Catch memory regressions in CI/CD
5. **Debugging**: Easier to debug OOM issues with memory tracking

## Next Steps

Future enhancements could include:

1. **CLI profile command**: `glubean profile` to generate comprehensive reports
2. **Memory assertions**: Built-in helpers like `ctx.assertMemory(< 100MB)`
3. **Dashboard integration**: Display memory trends over time
4. **Automatic recommendations**: Suggest tier based on actual usage
5. **Memory leak detection**: Automated leak detection patterns
