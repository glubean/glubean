import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { checkForUpdates, isNewer } from "./update_check.ts";

async function createTempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "glubean-update-check-" });
}

async function cleanupDir(dir: string): Promise<void> {
  try {
    await Deno.remove(dir, { recursive: true });
  } catch {
    // Ignore cleanup errors
  }
}

Deno.test(
  "checkForUpdates caches results and skips frequent fetches",
  async () => {
    const dir = await createTempDir();
    try {
      const cachePath = join(dir, "update-check.json");
      let fetchCount = 0;
      const fetchFn = () => {
        fetchCount += 1;
        return Promise.resolve(
          new Response(JSON.stringify({ latest: "1.2.3" }), { status: 200 }),
        );
      };

      await checkForUpdates("1.0.0", {
        cachePath,
        now: 1000,
        fetchFn,
      });

      await checkForUpdates("1.0.0", {
        cachePath,
        now: 2000,
        fetchFn,
      });

      assertEquals(fetchCount, 1);
    } finally {
      await cleanupDir(dir);
    }
  },
);

Deno.test("checkForUpdates fetches again after interval", async () => {
  const dir = await createTempDir();
  try {
    const cachePath = join(dir, "update-check.json");
    let fetchCount = 0;
    const fetchFn = () => {
      fetchCount += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ latest: "2.0.0" }), { status: 200 }),
      );
    };

    await checkForUpdates("1.0.0", {
      cachePath,
      now: 0,
      fetchFn,
    });

    await checkForUpdates("1.0.0", {
      cachePath,
      now: 25 * 60 * 60 * 1000,
      fetchFn,
    });

    assertEquals(fetchCount, 2);
  } finally {
    await cleanupDir(dir);
  }
});

// =============================================================================
// isNewer — semver comparison
// =============================================================================

Deno.test("isNewer - basic version comparison", () => {
  assertEquals(isNewer("2.0.0", "1.0.0"), true);
  assertEquals(isNewer("1.1.0", "1.0.0"), true);
  assertEquals(isNewer("1.0.1", "1.0.0"), true);
  assertEquals(isNewer("1.0.0", "1.0.0"), false);
  assertEquals(isNewer("1.0.0", "2.0.0"), false);
});

Deno.test("isNewer - stable release beats pre-release", () => {
  assertEquals(isNewer("1.0.0", "1.0.0-rc.9"), true);
  assertEquals(isNewer("1.0.0", "1.0.0-alpha.1"), true);
});

Deno.test("isNewer - pre-release does not beat stable", () => {
  assertEquals(isNewer("1.0.0-rc.1", "1.0.0"), false);
});

Deno.test("isNewer - pre-release ordering (rc.2 > rc.1)", () => {
  assertEquals(isNewer("1.0.0-rc.2", "1.0.0-rc.1"), true);
  assertEquals(isNewer("1.0.0-rc.1", "1.0.0-rc.2"), false);
  assertEquals(isNewer("1.0.0-rc.1", "1.0.0-rc.1"), false);
  assertEquals(isNewer("1.0.0-beta.1", "1.0.0-alpha.1"), true);
});

Deno.test("isNewer - build metadata is ignored", () => {
  assertEquals(isNewer("1.0.1+build.123", "1.0.0"), true);
  assertEquals(isNewer("1.0.0+build.999", "1.0.0+build.1"), false);
});

Deno.test("isNewer - numeric pre-release ids compared as integers", () => {
  assertEquals(isNewer("1.0.0-rc.10", "1.0.0-rc.9"), true);
  assertEquals(isNewer("1.0.0-rc.9", "1.0.0-rc.10"), false);
});
