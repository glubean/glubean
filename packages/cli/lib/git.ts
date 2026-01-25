/**
 * Git helper utilities for the Glubean CLI.
 *
 * All functions shell out to `git` via Deno.Command.
 */

/**
 * Check if the given directory (or cwd) is inside a git repository.
 */
export async function isGitRepo(dir?: string): Promise<boolean> {
  try {
    const cmd = new Deno.Command("git", {
      args: ["rev-parse", "--is-inside-work-tree"],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    });
    const { code } = await cmd.output();
    return code === 0;
  } catch {
    return false;
  }
}

/**
 * Get the contents of a file at a specific git ref.
 *
 * @param ref   Git ref (e.g. "HEAD", "main", "v1.0.0", a commit SHA)
 * @param filePath  File path relative to the repo root
 * @param dir   Working directory (defaults to cwd)
 * @returns File contents as a string, or null if the file doesn't exist at that ref.
 */
export async function gitShow(
  ref: string,
  filePath: string,
  dir?: string
): Promise<string | null> {
  try {
    const cmd = new Deno.Command("git", {
      args: ["show", `${ref}:${filePath}`],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    });
    const output = await cmd.output();
    if (output.code !== 0) return null;
    return new TextDecoder().decode(output.stdout);
  } catch {
    return null;
  }
}

/**
 * Get the repository root directory.
 */
export async function gitRoot(dir?: string): Promise<string | null> {
  try {
    const cmd = new Deno.Command("git", {
      args: ["rev-parse", "--show-toplevel"],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    });
    const output = await cmd.output();
    if (output.code !== 0) return null;
    return new TextDecoder().decode(output.stdout).trim();
  } catch {
    return null;
  }
}

/**
 * Get the relative path of a file from the git repo root.
 */
export async function gitRelativePath(
  filePath: string,
  dir?: string
): Promise<string | null> {
  try {
    const cmd = new Deno.Command("git", {
      args: ["ls-files", "--full-name", filePath],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    });
    const output = await cmd.output();
    if (output.code !== 0) return null;
    const result = new TextDecoder().decode(output.stdout).trim();
    // If file is not tracked, try using rev-parse to get relative path
    if (!result) {
      const rootDir = await gitRoot(dir);
      if (!rootDir) return null;
      const { resolve, relative } = await import("@std/path");
      const absPath = resolve(dir || Deno.cwd(), filePath);
      return relative(rootDir, absPath);
    }
    return result;
  } catch {
    return null;
  }
}
