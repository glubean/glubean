import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { checkForUpdates } from "./update_check.ts";

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
