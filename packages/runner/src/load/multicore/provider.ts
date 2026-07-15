/**
 * Multi-core load worker provider (parent side, proposal §5). `MultiCoreProvider` forks N
 * worker child processes (each running `worker-harness.js`), wraps each in a
 * {@link LoadWorkerChannel} over the fork's DEDICATED IPC channel, waits for every worker's
 * `hello`, and acts as the SUPERVISOR that holds the process group: it tracks each child's
 * pid and guarantees that every termination path (abort / channel loss / clean finish / a
 * future no-progress signal) reaps the child — limited-window SIGTERM then SIGKILL — so
 * `close()` never leaves an orphan.
 *
 * SCOPE (D1-3): this provider only PULLS N workers up, opens their channels, and manages
 * their lifecycle. It does NOT merge snapshots or finalize an artifact — the coordinator
 * core (snapshot fan-in, `mergePartials` + `finalizeMerged`, threshold evaluation) is D1-4.
 * A caller drives the workers with the raw channel API (`send` / `onMessage`).
 *
 * Isolation (hard requirement §6/§12): control frames are read ONLY from the IPC channel
 * (`child.on("message")`). The child's stdout/stderr — where user `console.log` lands — are
 * SEPARATE streams the provider never parses as protocol, so user code cannot forge or
 * disturb a control frame no matter what it writes.
 *
 * Runner resolution: reuses `subprocess.ts`'s machinery (`resolveRunnerRoot` +
 * `prepareZeroProject`) so the worker and the user `.load.ts` co-resolve one `@glubean/sdk`
 * — but forks the built `.js` harness with tsx's ESM loader registered IN-PROCESS
 * (`--import tsx/esm`) instead of spawning the `tsx` CLI, because the CLI re-spawns an inner
 * node and would drop the inherited IPC channel.
 */
import { fork, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import type { Readable } from "node:stream";
import { resolveRunnerRoot, prepareZeroProject, type ZeroProjectSetup } from "../../runner-resolve.js";
import {
  MULTICORE_PROTOCOL_VERSION,
  decodeWorkerMessage,
  encodeCoordinatorMessage,
  MulticoreProtocolError,
  type CoordinatorMessage,
  type WorkerMessage,
} from "./protocol.js";

// ── §5 provider abstraction ──────────────────────────────────────────────────

/** A worker's `hello` — its announced protocol version + coordinator-assigned identity. */
export interface LoadWorkerHello {
  protocolVersion: number;
  /** The workerId — echoed from the id the coordinator minted at fork (not self-claimed). */
  workerId: string;
  /** The child's OS process id (for supervision / diagnostics). */
  pid: number;
}

/** Why a channel closed (its child exited or the transport failed). */
export type ChannelCloseReason =
  | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null }
  | { kind: "error"; error: Error };

/**
 * The coordinator's handle on ONE worker (proposal §5). Transport-agnostic by shape —
 * multi-core backs it with fork IPC; remote (D2) will back the same interface with a
 * WebSocket. `send` delivers a coordinator frame; `onMessage` receives worker frames;
 * `close` starts this worker's supervised termination.
 */
export interface LoadWorkerChannel {
  /** The coordinator-minted workerId this channel is bound to. */
  readonly workerId: string;
  /** The child's process id. */
  readonly pid: number;
  /** The worker's `hello` (protocol version + identity), captured at acquire. */
  readonly hello: LoadWorkerHello;
  /** Deliver a coordinator frame to the worker; resolves once the transport accepts it. */
  send(msg: CoordinatorMessage): Promise<void>;
  /** Subscribe to decoded worker frames. */
  onMessage(cb: (msg: WorkerMessage) => void): void;
  /** Subscribe to channel close (the child exited or the transport failed). */
  onClose(cb: (reason: ChannelCloseReason) => void): void;
  /** Subscribe to transport errors (e.g. a spawn failure). */
  onError(cb: (err: Error) => void): void;
  /** Begin this worker's supervised termination (disconnect → SIGTERM → SIGKILL). Idempotent. */
  close(): void;
}

/** Options for `acquire` (proposal §5 `AcquireOptions`). */
export interface AcquireOptions {
  /** Deadline (from listener-ready) for every worker to `hello`; default 60s (multi-core).
   *  On timeout the acquire fails and every already-forked worker is terminated. */
  joinDeadlineMs?: number;
  /** Abort the acquire (and terminate any workers forked so far). */
  abort: AbortSignal;
}

/** The provider abstraction (proposal §5). */
export interface LoadWorkerProvider {
  acquire(n: number, opts: AcquireOptions): Promise<LoadWorkerChannel[]>;
}

// ── Bundled-path + tsx-loader resolution ─────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
// provider.js builds to dist/load/multicore/provider.js — the runner dist/ is two levels up,
// the package root three; the sibling worker-harness.js is the bundled fork entry.
const BUNDLED_DIST_DIR = resolve(__dirname, "..", "..");
const BUNDLED_PKG_ROOT = resolve(__dirname, "..", "..", "..");
const BUNDLED_WORKER_HARNESS = resolve(__dirname, "worker-harness.js");

let _tsxEsmUrl: string | undefined;
/** Resolve tsx's ESM loader entry (`tsx/esm`) as an absolute `file://` URL, so `--import`
 *  finds it regardless of the child's cwd (a user project rarely has tsx installed). Cached.
 *  This registers the TS transform IN-PROCESS in the forked worker (no CLI re-spawn), which
 *  is what keeps the inherited IPC channel alive. */
function resolveTsxEsmLoaderUrl(): string {
  if (_tsxEsmUrl) return _tsxEsmUrl;
  const req = createRequire(import.meta.url);
  _tsxEsmUrl = pathToFileURL(req.resolve("tsx/esm")).href;
  return _tsxEsmUrl;
}

/** The fork parameters shared by every worker of one acquire (computed once). */
interface ForkSetup {
  harnessPath: string;
  cwd: string;
  env: Record<string, string>;
  execArgv: string[];
  /** Undo any temp package.json the zero-project setup created. */
  cleanup: () => void;
}

function computeForkSetup(cwd: string): ForkSetup {
  // Resolve the runner exactly as `glubean run` / the single-file load spawn do, then prefer
  // the resolved runner's OWN multicore harness (co-resolves the project's sdk) and fall back
  // to the bundled sibling when the resolved runner predates multicore support (an older
  // published @glubean/runner). Same fallback shape as subprocess.ts's load-harness lookup.
  const resolved = resolveRunnerRoot(cwd, BUNDLED_DIST_DIR, BUNDLED_PKG_ROOT);
  let distDir = resolved.distDir;
  let pkgRoot = resolved.pkgRoot;
  let harnessPath = resolve(distDir, "load", "multicore", "worker-harness.js");
  if (!existsSync(harnessPath)) {
    distDir = BUNDLED_DIST_DIR;
    pkgRoot = BUNDLED_PKG_ROOT;
    harnessPath = BUNDLED_WORKER_HARNESS;
  }

  const zp: ZeroProjectSetup = prepareZeroProject(cwd, distDir, pkgRoot);
  const env: Record<string, string> = { ...process.env, ...zp.env } as Record<string, string>;
  // tsx ESM loader FIRST (so the user .ts transforms), then any zero-project resolver hook
  // (@glubean/* → vendored root). Both are absolute so cwd doesn't matter.
  const execArgv = ["--import", resolveTsxEsmLoaderUrl(), ...zp.tsxArgs];
  return { harnessPath, cwd, env, execArgv, cleanup: zp.cleanup };
}

// ── IPC-backed channel ───────────────────────────────────────────────────────

/** Grace given a child to exit after SIGTERM before SIGKILL. */
const DEFAULT_SIGTERM_GRACE_MS = 3_000;
/** Default worker join deadline for multi-core (proposal §5: 60s). */
const DEFAULT_JOIN_DEADLINE_MS = 60_000;

/**
 * A {@link LoadWorkerChannel} backed by a forked child's IPC channel. Control frames ride
 * `process.send` / the `"message"` event; the child's stdout/stderr (user output) are
 * exposed but NEVER read as protocol — the structural guarantee behind §12 isolation.
 */
class IpcWorkerChannel implements LoadWorkerChannel {
  readonly workerId: string;
  readonly pid: number;
  hello!: LoadWorkerHello;
  private readonly child: ChildProcess;
  private readonly messageCbs: Array<(msg: WorkerMessage) => void> = [];
  private readonly closeCbs: Array<(reason: ChannelCloseReason) => void> = [];
  private readonly errorCbs: Array<(err: Error) => void> = [];
  private sigkillTimer: ReturnType<typeof setTimeout> | undefined;
  private closing = false;
  /** Resolves when the child has exited — the supervisor awaits this for no-orphan close. */
  readonly exited: Promise<void>;
  private _exited = false;

  constructor(workerId: string, child: ChildProcess, private readonly graceMs: number) {
    this.workerId = workerId;
    this.child = child;
    this.pid = child.pid ?? -1;
    this.exited = new Promise<void>((resolveExit) => {
      child.on("exit", (code, signal) => {
        this._exited = true;
        if (this.sigkillTimer !== undefined) clearTimeout(this.sigkillTimer);
        for (const cb of this.closeCbs) cb({ kind: "exit", code, signal });
        resolveExit();
      });
    });
    child.on("error", (err) => {
      for (const cb of this.errorCbs) cb(err);
    });
    child.on("message", (raw: unknown) => {
      let msg: WorkerMessage;
      try {
        msg = decodeWorkerMessage(raw);
      } catch (e) {
        // A malformed worker frame is a transport error, not silently dropped.
        for (const cb of this.errorCbs) cb(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      for (const cb of this.messageCbs) cb(msg);
    });
  }

  /** The child's stdout (user `console.log`) — exposed for forwarding/inspection; the
   *  provider never treats it as protocol. */
  get stdout(): Readable | null {
    return this.child.stdout;
  }
  /** The child's stderr (user diagnostics / crash text). */
  get stderr(): Readable | null {
    return this.child.stderr;
  }
  get hasExited(): boolean {
    return this._exited;
  }

  send(msg: CoordinatorMessage): Promise<void> {
    return new Promise<void>((resolveSend, reject) => {
      if (this._exited || !this.child.connected) {
        reject(new Error(`worker ${this.workerId} channel is closed`));
        return;
      }
      this.child.send(encodeCoordinatorMessage(msg), (err: Error | null) =>
        err ? reject(err) : resolveSend(),
      );
    });
  }

  onMessage(cb: (msg: WorkerMessage) => void): void {
    this.messageCbs.push(cb);
  }
  onClose(cb: (reason: ChannelCloseReason) => void): void {
    if (this._exited) {
      // Already gone — fire immediately so a late subscriber isn't stranded.
      cb({ kind: "exit", code: null, signal: null });
      return;
    }
    this.closeCbs.push(cb);
  }
  onError(cb: (err: Error) => void): void {
    this.errorCbs.push(cb);
  }

  /**
   * Supervised termination (idempotent): close the IPC (the child's `disconnect` backstop
   * self-exits), SIGTERM as the escalation if that stalls, then SIGKILL after `graceMs` — a
   * bounded window so a wedged worker can never linger. Because tsx runs IN the worker (no
   * CLI re-spawn), a worker has NO child processes, so killing its pid fully terminates it —
   * no process-group (`setsid`/`-pid`) gymnastics are needed for this topology.
   */
  close(): void {
    if (this.closing || this._exited) return;
    this.closing = true;
    try {
      if (this.child.connected) this.child.disconnect();
    } catch {
      // already disconnected
    }
    try {
      this.child.kill("SIGTERM");
    } catch {
      // already gone
    }
    this.sigkillTimer = setTimeout(() => {
      if (!this._exited) {
        try {
          this.child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
    }, this.graceMs);
    this.sigkillTimer.unref?.();
  }
}

// ── Provider ─────────────────────────────────────────────────────────────────

/** Construction options — the provider is bound to ONE project (`cwd`), the coordinator's. */
export interface MultiCoreProviderOptions {
  /** Project root: drives runner resolution + is the workers' cwd. */
  cwd: string;
  /** Grace after SIGTERM before SIGKILL per worker (default 3s). */
  sigtermGraceMs?: number;
}

export class MultiCoreProvider implements LoadWorkerProvider {
  private readonly cwd: string;
  private readonly graceMs: number;
  private readonly channels: IpcWorkerChannel[] = [];
  private forkCleanup: (() => void) | undefined;
  private closed = false;

  constructor(opts: MultiCoreProviderOptions) {
    this.cwd = opts.cwd;
    this.graceMs = opts.sigtermGraceMs ?? DEFAULT_SIGTERM_GRACE_MS;
  }

  /**
   * Fork `n` workers, open their IPC channels, and wait for every `hello`. On ANY failure
   * before all have joined — a spawn error, a premature exit, an incompatible protocol
   * version, the join deadline, or the abort signal — every worker forked so far is
   * supervised-terminated and the acquire rejects (no orphan, no half-open pool).
   */
  async acquire(n: number, opts: AcquireOptions): Promise<LoadWorkerChannel[]> {
    if (this.closed) throw new Error("MultiCoreProvider: acquire after close()");
    if (!Number.isInteger(n) || n < 1) throw new Error(`MultiCoreProvider: worker count must be a positive integer (got ${n})`);

    const setup = computeForkSetup(this.cwd);
    // Keep the zero-project cleanup until close() — the temp package.json must survive for the
    // whole run (workers import the user file lazily on assign), not just past fork.
    this.forkCleanup = setup.cleanup;

    const joinDeadlineMs = opts.joinDeadlineMs ?? DEFAULT_JOIN_DEADLINE_MS;
    const channels: IpcWorkerChannel[] = [];
    try {
      for (let i = 0; i < n; i++) {
        const workerId = `w${i}`;
        const child = fork(setup.harnessPath, ["--worker-id", workerId], {
          cwd: setup.cwd,
          env: setup.env,
          execArgv: setup.execArgv,
          // fd 0/1/2 piped (user stdio, kept OFF the control path); the 4th slot is the
          // DEDICATED IPC control channel.
          stdio: ["pipe", "pipe", "pipe", "ipc"],
        });
        const channel = new IpcWorkerChannel(workerId, child, this.graceMs);
        channels.push(channel);
        this.channels.push(channel);
      }

      await this.awaitAllHellos(channels, joinDeadlineMs, opts.abort);
      return channels;
    } catch (e) {
      // Tear down everything forked in this acquire before surfacing the failure.
      await this.close();
      throw e;
    }
  }

  /** Wait for every channel's `hello`, validating the protocol version (an incompatible
   *  worker fails the acquire BEFORE any assign, §4). Rejects on deadline / abort / a worker
   *  dying or erroring before it says hello. */
  private awaitAllHellos(channels: IpcWorkerChannel[], deadlineMs: number, abort: AbortSignal): Promise<void> {
    return new Promise<void>((resolveAll, reject) => {
      let remaining = channels.length;
      let settled = false;
      const finishOk = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolveAll();
      };
      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };
      const timer = setTimeout(
        () => fail(new Error(`MultiCoreProvider: ${remaining}/${channels.length} worker(s) did not hello within ${deadlineMs}ms`)),
        deadlineMs,
      );
      const onAbort = (): void => fail(new Error("MultiCoreProvider: acquire aborted"));
      const cleanup = (): void => {
        clearTimeout(timer);
        abort.removeEventListener("abort", onAbort);
      };
      if (abort.aborted) {
        onAbort();
        return;
      }
      abort.addEventListener("abort", onAbort, { once: true });

      for (const channel of channels) {
        channel.onError((err) => fail(new Error(`worker ${channel.workerId} transport error before hello: ${err.message}`)));
        channel.onClose((reason) =>
          fail(
            new Error(
              `worker ${channel.workerId} exited before hello` +
                (reason.kind === "exit" ? ` (code ${reason.code}, signal ${reason.signal})` : ""),
            ),
          ),
        );
        channel.onMessage((msg) => {
          if (settled) return;
          if (msg.type !== "hello") {
            fail(new Error(`worker ${channel.workerId} sent ${msg.type} before hello`));
            return;
          }
          if (msg.protocolVersion !== MULTICORE_PROTOCOL_VERSION) {
            fail(
              new MulticoreProtocolError(
                `worker ${channel.workerId} speaks protocol ${msg.protocolVersion}, coordinator speaks ${MULTICORE_PROTOCOL_VERSION}`,
              ),
            );
            return;
          }
          if (msg.workerId !== channel.workerId) {
            fail(new Error(`worker ${channel.workerId} claimed a different id ${JSON.stringify(msg.workerId)}`));
            return;
          }
          channel.hello = { protocolVersion: msg.protocolVersion, workerId: msg.workerId, pid: msg.pid };
          remaining -= 1;
          if (remaining === 0) finishOk();
        });
      }
    });
  }

  /** The channels this provider currently supervises. */
  get workers(): readonly LoadWorkerChannel[] {
    return this.channels;
  }

  /**
   * Terminate every worker and wait for all to exit — the no-orphan guarantee. Each channel
   * runs its own disconnect → SIGTERM → SIGKILL escalation; this awaits all exits (bounded by
   * the SIGKILL that each channel arms), then runs the zero-project cleanup. Idempotent.
   */
  async close(): Promise<void> {
    this.closed = true;
    for (const channel of this.channels) channel.close();
    await Promise.all(this.channels.map((c) => c.exited));
    if (this.forkCleanup !== undefined) {
      this.forkCleanup();
      this.forkCleanup = undefined;
    }
  }
}
