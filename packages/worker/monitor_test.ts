import { assertEquals } from "@std/assert";
import { formatBytes, getProcessMemory, startProcessMonitor } from "./monitor.ts";
import { createNoopLogger } from "./logger.ts";

Deno.test("getProcessMemory returns memory for current process", async () => {
  const memory = await getProcessMemory(Deno.pid);

  // In restricted environments (containers, sandboxes), ps may not work
  if (memory === null) return;

  assertEquals(typeof memory, "number");
  assertEquals(memory > 0, true);
});

Deno.test("getProcessMemory returns null for non-existent process", async () => {
  const memory = await getProcessMemory(999999999);
  assertEquals(memory, null);
});

Deno.test("formatBytes formats correctly", () => {
  assertEquals(formatBytes(500), "500B");
  assertEquals(formatBytes(1024), "1.0KB");
  assertEquals(formatBytes(1024 * 1024), "1.0MB");
  assertEquals(formatBytes(1024 * 1024 * 1024), "1.0GB");
  assertEquals(formatBytes(1536 * 1024), "1.5MB");
});

Deno.test("startProcessMonitor does nothing with no limit", () => {
  const logger = createNoopLogger();
  const monitor = startProcessMonitor({
    pid: Deno.pid,
    memoryLimitBytes: 0, // No limit
    checkIntervalMs: 100,
    logger,
  });

  // Should not abort
  assertEquals(monitor.signal.aborted, false);
  monitor.stop();
});

Deno.test("startProcessMonitor can be stopped", async () => {
  const logger = createNoopLogger();
  const monitor = startProcessMonitor({
    pid: Deno.pid,
    memoryLimitBytes: 10 * 1024 * 1024 * 1024, // 10GB (won't trigger)
    checkIntervalMs: 100,
    logger,
  });

  // Wait a bit
  await new Promise((r) => setTimeout(r, 50));

  // Should not be aborted
  assertEquals(monitor.signal.aborted, false);

  // Stop and verify
  monitor.stop();
});
