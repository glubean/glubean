import { existsSync } from "node:fs";
import { resolve, dirname, relative, parse } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExecutionContext, ExecutionEvent, SingleExecutionOptions } from "./executor.js";
import { TestExecutor } from "./executor.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface OrchestratorOptions {
  /** Base context (vars, secrets) passed to all files */
  vars: Record<string, unknown>;
  secrets: Record<string, unknown>;
  /** Skip session setup/teardown */
  noSession?: boolean;
  /** Root directory to discover session.ts from */
  rootDir: string;
}

export interface FileScheduleEntry {
  filePath: string;
  dependsOn: string[];
}

export interface SessionState {
  data: Record<string, unknown>;
}

// ── Session Discovery ────────────────────────────────────────────────────────

const SESSION_FILE_NAMES = ["session.ts", "session.setup.ts"];

/**
 * Walk up from startDir to find the nearest session.ts or session.setup.ts.
 * Stops at stopDir (defaults to filesystem root).
 */
export function discoverSessionFile(
  startDir: string,
  stopDir?: string,
): string | undefined {
  let dir = startDir;
  const root = stopDir || parse(dir).root;
  while (true) {
    for (const name of SESSION_FILE_NAMES) {
      const candidate = resolve(dir, name);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    const parent = dirname(dir);
    if (parent === dir || dir === root) break;
    dir = parent;
  }
  return undefined;
}

// ── DAG Scheduling ───────────────────────────────────────────────────────────

/**
 * Build a topologically sorted execution order from file dependencies.
 * Returns files grouped into levels that can run in parallel.
 *
 * @throws Error if circular dependency detected
 */
export function buildExecutionOrder(
  entries: FileScheduleEntry[],
): string[][] {
  const fileSet = new Set(entries.map((e) => e.filePath));
  const adjList = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const entry of entries) {
    adjList.set(entry.filePath, []);
    inDegree.set(entry.filePath, 0);
  }

  for (const entry of entries) {
    for (const dep of entry.dependsOn) {
      const resolved = entries.find(
        (e) =>
          e.filePath === dep ||
          e.filePath.endsWith(`/${dep}`) ||
          relative(dirname(entries[0].filePath), e.filePath) === dep,
      );
      if (!resolved) {
        throw new Error(
          `dependsOn: '${dep}' in '${entry.filePath}' does not match any discovered test file`,
        );
      }
      if (!fileSet.has(resolved.filePath)) continue;
      adjList.get(resolved.filePath)!.push(entry.filePath);
      inDegree.set(
        entry.filePath,
        (inDegree.get(entry.filePath) ?? 0) + 1,
      );
    }
  }

  // Kahn's algorithm
  const levels: string[][] = [];
  let queue = entries
    .map((e) => e.filePath)
    .filter((f) => inDegree.get(f) === 0);
  let processed = 0;

  while (queue.length > 0) {
    levels.push([...queue]);
    processed += queue.length;
    const nextQueue: string[] = [];
    for (const file of queue) {
      for (const dependent of adjList.get(file) ?? []) {
        const newDeg = (inDegree.get(dependent) ?? 1) - 1;
        inDegree.set(dependent, newDeg);
        if (newDeg === 0) {
          nextQueue.push(dependent);
        }
      }
    }
    queue = nextQueue;
  }

  if (processed < entries.length) {
    const remaining = entries
      .filter((e) => (inDegree.get(e.filePath) ?? 0) > 0)
      .map((e) => e.filePath);
    throw new Error(
      `Circular dependency detected among: ${remaining.join(", ")}`,
    );
  }

  return levels;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Collects session:set events from an event stream, filtering them out
 * and accumulating session state. Returns remaining events.
 */
export function collectSessionUpdates(
  events: ExecutionEvent[],
  sessionState: Record<string, unknown>,
): ExecutionEvent[] {
  const filtered: ExecutionEvent[] = [];
  for (const event of events) {
    if (event.type === "session:set") {
      sessionState[event.key] = event.value;
    } else {
      filtered.push(event);
    }
  }
  return filtered;
}

/**
 * Create an ExecutionContext with session state injected.
 */
export function createContextWithSession(
  base: Pick<ExecutionContext, "vars" | "secrets">,
  session: Record<string, unknown>,
): ExecutionContext {
  return {
    vars: base.vars,
    secrets: base.secrets,
    session: { ...session },
  };
}

// ── RunOrchestrator ──────────────────────────────────────────────────────────

export interface SessionLifecycleEvent {
  phase: "setup" | "teardown";
  type: "started" | "completed" | "failed";
  error?: string;
  sessionKeyCount?: number;
}

/**
 * Orchestrates session lifecycle around test file execution.
 *
 * Handles: session.ts discovery → setup → inject state into tests → teardown.
 * Setup failure triggers best-effort teardown before propagating error.
 * Teardown always runs (even on test failures), errors are logged but don't fail the run.
 */
export class RunOrchestrator {
  constructor(private executor: TestExecutor) {}

  /**
   * Run session setup, returning accumulated session state.
   * Yields all events (including session:set for caller to accumulate).
   */
  async *runSessionSetup(
    sessionFile: string,
    context: Pick<ExecutionContext, "vars" | "secrets"> & { interactive?: boolean },
    options?: SingleExecutionOptions,
  ): AsyncGenerator<ExecutionEvent> {
    const sessionUrl = pathToFileURL(sessionFile).href;
    const ctx: ExecutionContext = {
      ...createContextWithSession(context, {}),
      sessionMode: "setup",
      interactive: context.interactive,
    };

    for await (const event of this.executor.run(
      sessionUrl,
      "__session__",
      ctx,
      options,
    )) {
      yield event;
    }
  }

  /**
   * Run session teardown with final accumulated session state.
   * Errors are caught and yielded as events — never throws.
   */
  async *runSessionTeardown(
    sessionFile: string,
    context: Pick<ExecutionContext, "vars" | "secrets">,
    sessionState: Record<string, unknown>,
    options?: SingleExecutionOptions,
  ): AsyncGenerator<ExecutionEvent> {
    const sessionUrl = pathToFileURL(sessionFile).href;
    const ctx: ExecutionContext = {
      ...createContextWithSession(context, sessionState),
      sessionMode: "teardown",
    };

    try {
      for await (const event of this.executor.run(
        sessionUrl,
        "__session__",
        ctx,
        options,
      )) {
        yield event;
      }
    } catch (err) {
      yield {
        type: "log",
        message: `Session teardown error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}
