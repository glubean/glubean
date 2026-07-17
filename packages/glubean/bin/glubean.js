#!/usr/bin/env node

// The executable selected by the shell is authoritative. A global `glubean`
// must not silently re-exec a project-local CLI: doing so makes `-V`,
// `upgrade`, command feedback, and bug fixes depend on the current directory.
// npm/pnpm scripts and VS Code still select their project-local binary through
// their own explicit resolution, while @glubean/runner separately resolves the
// project-local runtime for module-identity safety.

import { fileURLToPath } from "node:url";
import { detectProjectVersionDrift, formatProjectVersionDrift } from "./project-version-drift.js";

const drift = detectProjectVersionDrift({
  cwd: process.cwd(),
  launcherPath: fileURLToPath(import.meta.url),
});

if (drift) {
  console.error(formatProjectVersionDrift(drift));
}

await import("@glubean/cli");
