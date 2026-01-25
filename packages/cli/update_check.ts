import { dirname, join } from "@std/path";

const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_URL = "https://jsr.io/@glubean/cli/meta.json";

type UpdateCache = {
  lastChecked: number;
  latest?: string;
};

function parseSemver(version: string): number[] | null {
  const parts = version.split(".").map((part) => Number(part));
  if (parts.length < 3 || parts.some((part) => Number.isNaN(part))) {
    return null;
  }
  return parts.slice(0, 3);
}

function isNewer(latest: string, current: string): boolean {
  const latestParts = parseSemver(latest);
  const currentParts = parseSemver(current);
  if (!latestParts || !currentParts) return false;
  for (let i = 0; i < 3; i += 1) {
    if (latestParts[i] > currentParts[i]) return true;
    if (latestParts[i] < currentParts[i]) return false;
  }
  return false;
}

function getDefaultCachePath(): string | null {
  const home = Deno.env.get("HOME") || Deno.env.get("USERPROFILE");
  if (!home) return null;
  return join(home, ".glubean", "update-check.json");
}

export async function checkForUpdates(
  currentVersion: string,
  options?: {
    cachePath?: string;
    now?: number;
    fetchFn?: typeof fetch;
  }
): Promise<void> {
  try {
    const cachePath = options?.cachePath ?? getDefaultCachePath();
    if (!cachePath) return;

    const now = options?.now ?? Date.now();
    const fetchFn = options?.fetchFn ?? fetch;

    let cache: UpdateCache | null = null;
    try {
      cache = JSON.parse(await Deno.readTextFile(cachePath)) as UpdateCache;
    } catch {
      cache = null;
    }

    if (cache && now - cache.lastChecked < UPDATE_INTERVAL_MS) {
      if (cache.latest && isNewer(cache.latest, currentVersion)) {
        console.log(
          `Update available: glubean v${cache.latest} (current v${currentVersion}). ` +
            "Run: glubean upgrade"
        );
      }
      return;
    }

    let latest: string | undefined;
    try {
      const response = await fetchFn(UPDATE_URL);
      if (!response.ok) return;
      const data = (await response.json()) as { latest?: string };
      latest = data.latest;
    } catch {
      return;
    }

    try {
      await Deno.mkdir(dirname(cachePath), { recursive: true });
      const payload: UpdateCache = { lastChecked: now, latest };
      await Deno.writeTextFile(cachePath, JSON.stringify(payload));
    } catch {
      // Ignore cache write errors
    }

    if (latest && isNewer(latest, currentVersion)) {
      console.log(
        `Update available: glubean v${latest} (current v${currentVersion}). ` +
          "Run: glubean upgrade"
      );
    }
  } catch {
    // Ignore update check errors
  }
}
