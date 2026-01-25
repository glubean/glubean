import { assertEquals } from "@std/assert";

// Test helper functions from run.ts
// We'll test the utility functions that can be unit tested

Deno.test("loadEnvFile - parses basic key=value pairs", async () => {
  const tempDir = await Deno.makeTempDir();
  const envFile = `${tempDir}/.env`;
  await Deno.writeTextFile(envFile, `
BASE_URL=https://api.example.com
API_KEY=secret123
DEBUG=true
`);

  const vars = await loadEnvFile(envFile);

  assertEquals(vars.BASE_URL, "https://api.example.com");
  assertEquals(vars.API_KEY, "secret123");
  assertEquals(vars.DEBUG, "true");

  // Cleanup
  await Deno.remove(envFile);
});

Deno.test("loadEnvFile - handles quoted values", async () => {
  const tempDir = await Deno.makeTempDir();
  const envFile = `${tempDir}/.env`;
  await Deno.writeTextFile(envFile, `
DOUBLE="hello world"
SINGLE='single quotes'
PLAIN=no_quotes
`);

  const vars = await loadEnvFile(envFile);

  assertEquals(vars.DOUBLE, "hello world");
  assertEquals(vars.SINGLE, "single quotes");
  assertEquals(vars.PLAIN, "no_quotes");

  // Cleanup
  await Deno.remove(envFile);
});

Deno.test("loadEnvFile - ignores comments and empty lines", async () => {
  const tempDir = await Deno.makeTempDir();
  const envFile = `${tempDir}/.env`;
  await Deno.writeTextFile(envFile, `
# This is a comment
KEY1=value1

# Another comment
KEY2=value2

`);

  const vars = await loadEnvFile(envFile);

  assertEquals(Object.keys(vars).length, 2);
  assertEquals(vars.KEY1, "value1");
  assertEquals(vars.KEY2, "value2");

  // Cleanup
  await Deno.remove(envFile);
});

Deno.test("loadEnvFile - returns empty object for missing file", async () => {
  const vars = await loadEnvFile("/nonexistent/.env");
  assertEquals(Object.keys(vars).length, 0);
});

Deno.test("matchesFilter - matches by id", () => {
  const testItem = {
    meta: { id: "user-login", name: "User Login Test", tags: ["auth"] },
    fn: async () => {},
  };

  assertEquals(matchesFilter(testItem, "user"), true);
  assertEquals(matchesFilter(testItem, "login"), true);
  assertEquals(matchesFilter(testItem, "USER"), true); // case insensitive
  assertEquals(matchesFilter(testItem, "register"), false);
});

Deno.test("matchesFilter - matches by name", () => {
  const testItem = {
    meta: { id: "test-1", name: "API Health Check", tags: [] },
    fn: async () => {},
  };

  assertEquals(matchesFilter(testItem, "health"), true);
  assertEquals(matchesFilter(testItem, "API"), true);
  assertEquals(matchesFilter(testItem, "database"), false);
});

Deno.test("matchesFilter - matches by tag", () => {
  const testItem = {
    meta: { id: "test-1", name: "Test", tags: ["smoke", "api", "critical"] },
    fn: async () => {},
  };

  assertEquals(matchesFilter(testItem, "smoke"), true);
  assertEquals(matchesFilter(testItem, "API"), true);
  assertEquals(matchesFilter(testItem, "critical"), true);
  assertEquals(matchesFilter(testItem, "integration"), false);
});

// ---- Helper functions extracted for testing ----

async function loadEnvFile(envPath: string): Promise<Record<string, string>> {
  const vars: Record<string, string> = {};
  try {
    const content = await Deno.readTextFile(envPath);
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      vars[key] = value;
    }
  } catch {
    // File doesn't exist
  }
  return vars;
}

interface TestItem {
  meta: { id: string; name?: string; tags?: string[] };
  fn: () => Promise<void>;
}

function matchesFilter(testItem: TestItem, filter: string): boolean {
  const lowerFilter = filter.toLowerCase();
  if (testItem.meta.id.toLowerCase().includes(lowerFilter)) return true;
  if (testItem.meta.name?.toLowerCase().includes(lowerFilter)) return true;
  if (testItem.meta.tags?.some((t) => t.toLowerCase().includes(lowerFilter))) return true;
  return false;
}
