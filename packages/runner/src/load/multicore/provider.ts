/**
 * Multi-core load worker provider (parent side, proposal §5). `MultiCoreProvider` spawns N
 * worker child processes (each running `worker-harness.js`), wraps each in a
 * {@link LoadWorkerChannel} over a DEDICATED inherited control fd, waits for every worker's
 * `hello`, and acts as the SUPERVISOR that holds the process group: it tracks each child's
 * pid and guarantees that every termination path (abort / channel loss / clean finish / a
 * future no-progress signal) reaps the child — SIGTERM → SIGKILL → a hard bounded deadline —
 * so `close()` never leaves an orphan and never hangs.
 *
 * TRANSPORT (proposal §4 "专用控制通道 … 继承 fd"): the control channel is a dedicated
 * inherited pipe on fd 3, NOT Node's fork IPC. The child is `spawn`ed with
 * `stdio: ['pipe','pipe','pipe','pipe']` — fd 0/1/2 are the user's stdio (drained/forwarded),
 * and fd 3 is a duplex pipe carrying the protocol as NDJSON (one JSON frame per line). This is
 * what makes isolation STRUCTURAL rather than defensive: the child has NO IPC channel at all
 * (`process.send === undefined`, `process.on("message")` never fires, `process.connected`
 * false), so user code / libraries cannot observe or forge a control frame — there is nothing
 * on the process IPC surface to reach for. (The earlier fork-IPC transport shared that surface
 * with user code, which is why isolation had to be patched repeatedly.) The same protocol,
 * unchanged, is what D2 `remote` reuses over WebSocket — only the transport differs.
 *
 * SCOPE (D1-3): this provider only PULLS N workers up, opens their channels, and manages their
 * lifecycle. It does NOT merge snapshots or finalize an artifact — the coordinator core
 * (snapshot fan-in, `mergePartials` + `finalizeMerged`, threshold evaluation) is D1-4. A caller
 * drives the workers with the raw channel API (`send` / `onMessage`).
 *
 * Runner resolution: reuses `subprocess.ts`'s machinery (`resolveRunnerRoot` +
 * `prepareZeroProject`) so the worker and the user `.load.ts` co-resolve one `@glubean/sdk` —
 * spawning the built `.js` harness with tsx's ESM loader registered IN-PROCESS
 * (`--import tsx/esm`) rather than the `tsx` CLI (which re-spawns an inner node and would drop
 * the inherited fd 3).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import type { Duplex, Readable } from "node:stream";
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
  /** The workerId — echoed from the id the coordinator minted at spawn (not self-claimed). */
  workerId: string;
  /** The child's OS process id (for supervision / diagnostics). */
  pid: number;
}

/** Why a channel closed. `exit` — the child process ended; `error` — a PRE-SPAWN failure (no
 *  pid was ever assigned); `could-not-reap` — even SIGKILL did not yield an exit within the
 *  hard teardown deadline (uninterruptible sleep / EPERM / zombie), settled so `close()` stays
 *  bounded (a possible lingering process, surfaced rather than hidden). */
export type ChannelCloseReason =
  | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null }
  | { kind: "error"; error: Error }
  | { kind: "could-not-reap" };

/**
 * The coordinator's handle on ONE worker (proposal §5). Transport-agnostic by shape —
 * multi-core backs it with a dedicated fd-3 pipe; remote (D2) will back the same interface
 * with a WebSocket. `send` delivers a coordinator frame; `onMessage` receives worker frames;
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
  /** Begin this worker's supervised termination (fd-3 EOF → SIGTERM → SIGKILL → hard deadline).
   *  Idempotent. */
  close(): void;
}

/** Options for `acquire` (proposal §5 `AcquireOptions`). */
export interface AcquireOptions {
  /** Deadline (from listener-ready) for every worker to `hello`; default 60s (multi-core).
   *  On timeout the acquire fails and every already-spawned worker is terminated. */
  joinDeadlineMs?: number;
  /** Abort the acquire (and terminate any workers spawned so far). */
  abort: AbortSignal;
}

/** The provider abstraction (proposal §5). */
export interface LoadWorkerProvider {
  acquire(n: number, opts: AcquireOptions): Promise<LoadWorkerChannel[]>;
}

// ── Bundled-path + tsx-loader resolution ─────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
// provider.js builds to dist/load/multicore/provider.js — the runner dist/ is two levels up,
// the package root three; the sibling worker-harness.js is the bundled spawn entry.
const BUNDLED_DIST_DIR = resolve(__dirname, "..", "..");
const BUNDLED_PKG_ROOT = resolve(__dirname, "..", "..", "..");
const BUNDLED_WORKER_HARNESS = resolve(__dirname, "worker-harness.js");

/** The inherited control fd index. fd 0/1/2 are the user's stdio; fd 3 is the dedicated
 *  duplex control pipe the protocol rides (NDJSON). */
const CONTROL_FD = 3;

let _tsxEsmUrl: string | undefined;
/** Resolve tsx's ESM loader entry (`tsx/esm`) as an absolute `file://` URL, so `--import`
 *  finds it regardless of the child's cwd (a user project rarely has tsx installed). Cached.
 *  This registers the TS transform IN-PROCESS in the spawned worker (no CLI re-spawn), which
 *  is what keeps the inherited control fd intact. */
function resolveTsxEsmLoaderUrl(): string {
  if (_tsxEsmUrl) return _tsxEsmUrl;
  const req = createRequire(import.meta.url);
  _tsxEsmUrl = pathToFileURL(req.resolve("tsx/esm")).href;
  return _tsxEsmUrl;
}

/** The spawn parameters shared by every worker of one acquire (computed once). */
interface SpawnSetup {
  harnessPath: string;
  cwd: string;
  env: Record<string, string>;
  /** node flags (tsx loader + zero-project resolver) that precede the harness on the argv. */
  execArgv: string[];
  /** Undo any temp package.json the zero-project setup created. */
  cleanup: () => void;
}

function computeSpawnSetup(cwd: string): SpawnSetup {
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

// ── fd-3 control channel ─────────────────────────────────────────────────────

/** Grace given a child to exit after SIGTERM before SIGKILL. */
const DEFAULT_SIGTERM_GRACE_MS = 3_000;
/** Default worker join deadline for multi-core (proposal §5: 60s). */
const DEFAULT_JOIN_DEADLINE_MS = 60_000;

/**
 * A {@link LoadWorkerChannel} backed by a spawned child's DEDICATED fd-3 control pipe. Control
 * frames ride fd 3 as NDJSON (one JSON frame per line); the child's stdout/stderr (user output)
 * are separate streams the provider drains but NEVER parses as protocol. The child has no IPC
 * surface, so user code cannot forge or observe a control frame — isolation is structural.
 *
 * Exported for the D1-4 coordinator + supervision unit tests (which drive it with a stub
 * `ChildProcess` + fake control stream); production callers construct it via
 * {@link MultiCoreProvider.acquire}.
 */
export class Fd3WorkerChannel implements LoadWorkerChannel {
  readonly workerId: string;
  readonly pid: number;
  hello!: LoadWorkerHello;
  private readonly child: ChildProcess;
  /** The dedicated control pipe (child.stdio[CONTROL_FD]). */
  private readonly control: Duplex;
  private rxBuf = "";
  private readonly messageCbs: Array<(msg: WorkerMessage) => void> = [];
  private readonly closeCbs: Array<(reason: ChannelCloseReason) => void> = [];
  private readonly errorCbs: Array<(err: Error) => void> = [];
  private sigkillTimer: ReturnType<typeof setTimeout> | undefined;
  private reapTimer: ReturnType<typeof setTimeout> | undefined;
  private closing = false;
  /** Resolves when the child has been reaped (or the hard deadline gave up) — the supervisor
   *  awaits this for a bounded no-orphan close. */
  readonly exited: Promise<void>;
  private resolveExit!: () => void;
  private _exited = false;
  private _closeReason: ChannelCloseReason | undefined;

  constructor(
    workerId: string,
    child: ChildProcess,
    private readonly graceMs: number,
    private readonly forwardOutput: boolean,
  ) {
    this.workerId = workerId;
    this.child = child;
    this.pid = child.pid ?? -1;
    this.control = child.stdio[CONTROL_FD] as unknown as Duplex;
    this.exited = new Promise<void>((r) => {
      this.resolveExit = r;
    });

    child.on("exit", (code, signal) => this.settleClosed({ kind: "exit", code, signal }));
    child.on("error", (err) => {
      for (const cb of this.errorCbs) cb(err);
      // ONLY a PRE-SPAWN failure — no pid was ever assigned (EMFILE / EAGAIN / a bad execPath) —
      // never yields an `exit`, so synthesize the close here or `close()` / `awaitAllHellos`
      // would wait forever. A post-spawn error on a LIVE process (it HAS a pid) must NOT be
      // mistaken for an exit: keep `_exited` false and let the REAL `exit` (natural, or forced by
      // `close()`) settle it — else the supervisor skips termination and falsely reports reaped.
      if (child.pid === undefined) this.settleClosed({ kind: "error", error: err });
    });

    // Inbound control frames: NDJSON on fd 3. Buffer to a newline, JSON.parse + decode each line.
    if (this.control !== undefined && this.control !== null) {
      this.control.setEncoding("utf8");
      this.control.on("data", (chunk: string) => this.onControlData(chunk));
      // A transport error on the control pipe is surfaced (not silently dropped); the child's
      // own `exit` still drives settlement.
      this.control.on("error", (err: Error) => {
        for (const cb of this.errorCbs) cb(err);
      });
    }

    // DRAIN the user stdout/stderr pipes continuously (attached at construction, before any
    // assign): a verbose worker that fills the OS pipe buffer would otherwise BLOCK on its next
    // stdout write — potentially before it can send `done` — and hang the whole run. A `data`
    // listener keeps each stream flowing (drained); `forwardOutput` echoes it to the
    // coordinator's own stdout/stderr (parity with subprocess.ts) or discards it. Additional
    // `.stdout`/`.stderr` subscribers (a coordinator/test) still receive every chunk.
    child.stdout?.on("data", (chunk: Buffer) => {
      if (this.forwardOutput) process.stdout.write(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (this.forwardOutput) process.stderr.write(chunk);
    });
  }

  /** Frame + fire close callbacks + resolve `exited` exactly once. */
  private settleClosed(reason: ChannelCloseReason): void {
    if (this._exited) return;
    this._exited = true;
    this._closeReason = reason;
    if (this.sigkillTimer !== undefined) clearTimeout(this.sigkillTimer);
    if (this.reapTimer !== undefined) clearTimeout(this.reapTimer);
    for (const cb of this.closeCbs) cb(reason);
    this.resolveExit();
  }

  /** NDJSON de-framer for inbound control data (handles split / coalesced frames). */
  private onControlData(chunk: string): void {
    this.rxBuf += chunk;
    let nl: number;
    while ((nl = this.rxBuf.indexOf("\n")) >= 0) {
      const line = this.rxBuf.slice(0, nl);
      this.rxBuf = this.rxBuf.slice(nl + 1);
      if (line.length === 0) continue;
      let msg: WorkerMessage;
      try {
        msg = decodeWorkerMessage(JSON.parse(line) as unknown);
      } catch (e) {
        // A malformed / undecodable frame is a transport error, not silently dropped.
        for (const cb of this.errorCbs) cb(e instanceof Error ? e : new Error(String(e)));
        continue;
      }
      for (const cb of this.messageCbs) cb(msg);
    }
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
      if (this._exited || this.control === undefined || this.control === null || this.control.destroyed) {
        reject(new Error(`worker ${this.workerId} control channel is closed`));
        return;
      }
      // One NDJSON frame. Resolve on the write callback (frame handed to the kernel) so a caller
      // — e.g. the harness awaiting terminal-frame delivery — knows it is on the wire.
      this.control.write(JSON.stringify(encodeCoordinatorMessage(msg)) + "\n", (err) =>
        err ? reject(err) : resolveSend(),
      );
    });
  }

  onMessage(cb: (msg: WorkerMessage) => void): void {
    this.messageCbs.push(cb);
  }
  onClose(cb: (reason: ChannelCloseReason) => void): void {
    if (this._exited) {
      // Already gone — replay the real close reason so a late subscriber (e.g. `awaitAllHellos`
      // registering after an async spawn `error`) isn't stranded and sees why.
      cb(this._closeReason ?? { kind: "exit", code: null, signal: null });
      return;
    }
    this.closeCbs.push(cb);
  }
  onError(cb: (err: Error) => void): void {
    this.errorCbs.push(cb);
  }

  /**
   * Supervised termination (idempotent + BOUNDED): end the control pipe (the child's fd-3
   * EOF backstop self-exits), SIGTERM as the escalation, SIGKILL after `graceMs`, and — because
   * even SIGKILL cannot reap an uninterruptible-sleep / EPERM / zombie process — a HARD deadline
   * at `2·graceMs` that settles the channel `could-not-reap` so `close()` can never hang forever.
   * Because tsx runs IN the worker (no CLI re-spawn), a worker has NO child processes, so killing
   * its pid fully terminates it — no process-group (`setsid`/`-pid`) gymnastics for this topology.
   */
  close(): void {
    if (this.closing || this._exited) return;
    this.closing = true;
    // End our write side of fd 3 → the child sees EOF on its control socket and self-exits
    // (the disconnect backstop), even if the parent later crashes.
    try {
      this.control?.end();
    } catch {
      // already ended
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
    // Bounded teardown backstop: if no real `exit` has arrived a full grace window after SIGKILL,
    // give up waiting and settle synthetically rather than leave `close()` pending forever.
    this.reapTimer = setTimeout(() => this.settleClosed({ kind: "could-not-reap" }), this.graceMs * 2);
    this.reapTimer.unref?.();
  }
}

// ── Provider ─────────────────────────────────────────────────────────────────

/** Construction options — the provider is bound to ONE project (`cwd`), the coordinator's. */
export interface MultiCoreProviderOptions {
  /** Project root: drives runner resolution + is the workers' cwd. */
  cwd: string;
  /** Grace after SIGTERM before SIGKILL per worker (default 3s); the hard teardown deadline is
   *  `2×` this. */
  sigtermGraceMs?: number;
  /** Echo each worker's stdout/stderr (user `console.log` / diagnostics) to the coordinator's
   *  own stdout/stderr — parity with subprocess.ts. Default `true`. Regardless of this flag the
   *  streams are always DRAINED (a `data` listener is attached) so a verbose worker can never
   *  block on a full pipe; `false` drains-and-discards (quiet). */
  forwardOutput?: boolean;
  /** Node executable used to spawn workers. Default `process.execPath`. (Exposed so a
   *  deployment can pin a specific node; a non-existent path surfaces as a spawn `error`.) */
  nodeExecPath?: string;
}

export class MultiCoreProvider implements LoadWorkerProvider {
  private readonly cwd: string;
  private readonly graceMs: number;
  private readonly forwardOutput: boolean;
  private readonly nodeExecPath: string | undefined;
  private readonly channels: Fd3WorkerChannel[] = [];
  private spawnCleanup: (() => void) | undefined;
  private closed = false;

  constructor(opts: MultiCoreProviderOptions) {
    this.cwd = opts.cwd;
    this.graceMs = opts.sigtermGraceMs ?? DEFAULT_SIGTERM_GRACE_MS;
    this.forwardOutput = opts.forwardOutput ?? true;
    this.nodeExecPath = opts.nodeExecPath;
  }

  /**
   * Spawn `n` workers, open their fd-3 control channels, and wait for every `hello`. On ANY
   * failure before all have joined — a spawn error, a premature exit, an incompatible protocol
   * version, the join deadline, or the abort signal — every worker spawned so far is
   * supervised-terminated and the acquire rejects (no orphan, no half-open pool).
   */
  async acquire(n: number, opts: AcquireOptions): Promise<LoadWorkerChannel[]> {
    if (this.closed) throw new Error("MultiCoreProvider: acquire after close()");
    if (!Number.isInteger(n) || n < 1) throw new Error(`MultiCoreProvider: worker count must be a positive integer (got ${n})`);

    const setup = computeSpawnSetup(this.cwd);
    // Keep the zero-project cleanup until close() — the temp package.json must survive for the
    // whole run (workers import the user file lazily on assign), not just past spawn.
    this.spawnCleanup = setup.cleanup;

    const command = this.nodeExecPath ?? process.execPath;
    const joinDeadlineMs = opts.joinDeadlineMs ?? DEFAULT_JOIN_DEADLINE_MS;
    const channels: Fd3WorkerChannel[] = [];
    try {
      for (let i = 0; i < n; i++) {
        const workerId = `w${i}`;
        const child = spawn(command, [...setup.execArgv, setup.harnessPath, "--worker-id", workerId], {
          cwd: setup.cwd,
          env: setup.env,
          // fd 0/1/2 piped (user stdio, kept OFF the control path); fd 3 is the DEDICATED
          // duplex control pipe — the child has NO IPC channel, so user code cannot reach it.
          stdio: ["pipe", "pipe", "pipe", "pipe"],
        });
        const channel = new Fd3WorkerChannel(workerId, child, this.graceMs, this.forwardOutput);
        channels.push(channel);
        this.channels.push(channel);
      }

      await this.awaitAllHellos(channels, joinDeadlineMs, opts.abort);
      return channels;
    } catch (e) {
      // Tear down everything spawned in this acquire before surfacing the failure.
      await this.close();
      throw e;
    }
  }

  /** Wait for every channel's `hello`, validating the protocol version (an incompatible
   *  worker fails the acquire BEFORE any assign, §4). Rejects on deadline / abort / a worker
   *  dying or erroring before it says hello. */
  private awaitAllHellos(channels: Fd3WorkerChannel[], deadlineMs: number, abort: AbortSignal): Promise<void> {
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
                (reason.kind === "exit" ? ` (code ${reason.code}, signal ${reason.signal})` : ` (${reason.kind})`),
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
   * Terminate every worker and wait for all to settle — the BOUNDED no-orphan guarantee. Each
   * channel runs its own fd-3 EOF → SIGTERM → SIGKILL → hard-deadline escalation; this awaits
   * all of them (each settles within `2×graceMs` even if the OS cannot reap it), then runs the
   * zero-project cleanup. Idempotent.
   */
  async close(): Promise<void> {
    this.closed = true;
    for (const channel of this.channels) channel.close();
    await Promise.all(this.channels.map((c) => c.exited));
    if (this.spawnCleanup !== undefined) {
      this.spawnCleanup();
      this.spawnCleanup = undefined;
    }
  }
}
