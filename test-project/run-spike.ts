/**
 * Spike test: Can tsx + Node.js runner execute a glubean test file end-to-end?
 */
import { TestExecutor } from "@glubean/runner";
import { resolve } from "node:path";

const testFile = resolve(import.meta.dirname!, "hello.test.ts");

const executor = new TestExecutor({
  cwd: import.meta.dirname!,
});

console.log("=== Spike Test: Node.js Runner ===");
console.log(`Test file: ${testFile}`);
console.log("");

const result = await executor.execute(
  testFile,
  "hello-world",
  { vars: {}, secrets: {} },
  { timeout: 10000 },
);

console.log("=== Result ===");
console.log(`Success: ${result.success}`);
console.log(`Duration: ${result.duration}ms`);
console.log(`Assertions: ${result.assertionCount} (${result.failedAssertionCount} failed)`);

if (result.error) {
  console.log(`Error: ${result.error}`);
}

console.log("");
console.log("=== Events ===");
for (const event of result.events) {
  console.log(JSON.stringify(event));
}

process.exit(result.success ? 0 : 1);
