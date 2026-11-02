import { randomUUID } from "node:crypto";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { execCommand } from "@getpaseo/plugin/server";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildArgv, type ParamValues } from "../shared/params";
import type { Action } from "../shared/schema";
import type { RunnerSettings } from "../shared/settings";
import { findAction, type PackLoad } from "./packs";
import { RingBuffer } from "./ring";

export const OUTPUT_CAP_BYTES = 256 * 1024;
export const FINISHED_JOBS_PER_ACTION = 50;

export type JobState = "running" | "succeeded" | "failed" | "timeout" | "cancelled" | "unknown";

export type StartErrorCode =
  | "invalid_settings"
  | "unknown_action"
  | "not_approved"
  | "disabled"
  | "confirmation_required"
  | "already_running"
  | "invalid_params"
  | "workspace_unset"
  | "request_id_conflict"
  | "spawn_failed";

export type StartResult =
  | { ok: true; jobId: string }
  | { ok: false; code: StartErrorCode; message: string; jobId?: string };

export type CancelResult =
  | { ok: true; state: JobState }
  | { ok: false; code: "not_found" | "not_running" | "identity_unverified"; message: string };

export interface JobView {
  state: JobState;
  exitCode?: number;
  message?: string;
  output: string;
  startCursor: number;
  nextCursor: number;
  truncated: boolean;
}

export type Spawner = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

/** Process identity checks used for restart reconciliation and cancelling orphans. */
export interface ProcessProbe {
  isAlive(pid: number): boolean;
  startTime(pid: number): Promise<string | undefined>;
}

export interface SettingsSnapshot {
  settings: RunnerSettings | undefined;
  error?: string;
}

export interface JobManagerOptions {
  dataDir: string;
  spawner: Spawner;
  loadPacks: () => Promise<PackLoad>;
  readSettings: () => Promise<SettingsSnapshot>;
  now?: () => number;
  /** Schedules `fn` after `ms` and returns a canceller. Tests inject a manual scheduler. */
  schedule?: (fn: () => void, ms: number) => () => void;
  /** Source of PATH, HOME, LANG and USER for child environments. */
  baseEnv?: NodeJS.ProcessEnv;
  probe?: ProcessProbe;
  /** Delay between the graceful signal and the forced kill of a process group. */
  graceMs?: number;
  /** Wait for output streams to close after the child exits. */
  settleMs?: number;
}

interface Job {
  id: string;
  actionId: string;
  requestId: string;
  state: JobState;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  message?: string;
  pid?: number;
  pidStartTime?: string;
  ring?: RingBuffer;
  child?: ChildProcess;
  /** Why the manager ended the job, when it did. */
  reason?: "timeout" | "cancelled";
  cancelTimer?: () => void;
  killTimer?: () => void;
  done?: Promise<void>;
}

interface PersistedJob {
  id: string;
  actionId: string;
  requestId: string;
  state: JobState;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  message?: string;
  pid?: number;
  pidStartTime?: string;
}

const ENV_KEYS = ["PATH", "HOME", "LANG", "USER"] as const;
const INDEX_FILE = "jobs.json";
const AUDIT_FILE = "audit.jsonl";

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const handle = setTimeout(fn, ms);
  handle.unref();
  return () => clearTimeout(handle);
};

export const systemProbe: ProcessProbe = {
  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  async startTime(pid) {
    // POSIX only: `ps -o lstart=` prints the process start time. Windows is not supported.
    try {
      const { stdout } = await execCommand("ps", ["-o", "lstart=", "-p", String(pid)], {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C" },
        shell: false,
        timeout: 3000,
      });
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  },
};

/** Drop a trailing partial UTF-8 sequence so the next cursor lands on a character boundary. */
function completeUtf8Length(data: Buffer): number {
  for (let back = 1; back <= Math.min(3, data.length); back++) {
    const byte = data[data.length - back];
    if ((byte & 0xc0) === 0x80) continue;
    const needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return needed > back ? data.length - back : data.length;
  }
  return data.length;
}

export class JobManager {
  private readonly jobs = new Map<string, Job>();
  private readonly requestIds = new Map<string, string>();
  private readonly opts: Required<Omit<JobManagerOptions, "baseEnv">> & { baseEnv: NodeJS.ProcessEnv };
  private ready: Promise<void> | undefined;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: JobManagerOptions) {
    this.opts = {
      now: Date.now,
      schedule: defaultSchedule,
      baseEnv: process.env,
      probe: systemProbe,
      graceMs: 3000,
      settleMs: 250,
      ...options,
    };
  }

  /** Load the persisted index once; jobs recorded as running become `unknown`. */
  init(): Promise<void> {
    this.ready ??= this.reconcile();
    return this.ready;
  }

  private async reconcile(): Promise<void> {
    let persisted: PersistedJob[] = [];
    try {
      const parsed = JSON.parse(await readFile(join(this.opts.dataDir, INDEX_FILE), "utf8")) as {
        jobs?: PersistedJob[];
      };
      persisted = Array.isArray(parsed.jobs) ? parsed.jobs : [];
    } catch {
      // Missing or unreadable index: start empty.
    }
    let changed = false;
    for (const entry of persisted) {
      const job: Job = { ...entry };
      if (job.state === "running") {
        job.state = "unknown";
        job.message = "interrupted by restart";
        changed = true;
        this.audit({ event: "reconcile", jobId: job.id, actionId: job.actionId, state: "unknown" });
      }
      this.jobs.set(job.id, job);
      this.requestIds.set(job.requestId, job.id);
    }
    if (changed) await this.persist();
  }

  async start(input: {
    actionId: string;
    values: ParamValues;
    requestId: string;
    confirmed: boolean;
  }): Promise<StartResult> {
    await this.init();
    const { actionId, values, requestId } = input;
    const paramNames = Object.keys(values).sort();
    const deny = (code: StartErrorCode, message: string, jobId?: string): StartResult => {
      this.audit({ event: "denied", actionId: actionId.slice(0, 200), code, reason: message, paramNames });
      return jobId === undefined ? { ok: false, code, message } : { ok: false, code, message, jobId };
    };

    const [snapshot, load] = await Promise.all([this.opts.readSettings(), this.opts.loadPacks()]);

    // Everything from here to the spawn is synchronous, so concurrent starts cannot interleave.
    const existingId = this.requestIds.get(requestId);
    if (existingId !== undefined) {
      const existing = this.jobs.get(existingId);
      if (existing && existing.actionId === actionId) return { ok: true, jobId: existingId };
      return deny("request_id_conflict", "requestId was already used for a different action");
    }
    if (!snapshot.settings) return deny("invalid_settings", snapshot.error ?? "runner settings are invalid");
    const found = findAction(load, actionId);
    if (!found) return deny("unknown_action", `no action "${actionId}"`);
    const { pack, action } = found;
    if (!pack.approved) {
      return deny("not_approved", `pack "${pack.manifest.name}" is not approved for its current manifest`);
    }
    if (pack.disabled) return deny("disabled", `pack "${pack.manifest.name}" is disabled`);
    if (action.confirm && input.confirmed !== true) {
      return deny("confirmation_required", `action "${actionId}" requires confirmation`);
    }
    if (action.concurrency === "single") {
      const running = [...this.jobs.values()].find((job) => job.actionId === actionId && job.state === "running");
      if (running) return deny("already_running", `action "${actionId}" is already running`, running.id);
    }
    const built = buildArgv(action, values);
    if ("error" in built) return deny("invalid_params", built.error);
    const cwd = this.resolveCwd(action, pack.dir, snapshot.settings);
    if (cwd === undefined) {
      return deny("workspace_unset", `action "${actionId}" uses $WORKSPACE but workspaceDir is not configured`);
    }

    const job: Job = {
      id: randomUUID(),
      actionId,
      requestId,
      state: "running",
      startedAt: this.opts.now(),
      ring: new RingBuffer(OUTPUT_CAP_BYTES),
    };
    const [command, ...args] = built.argv;
    let child: ChildProcess;
    try {
      child = this.opts.spawner(command, args, {
        cwd,
        env: this.childEnv(),
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      return deny("spawn_failed", (error as Error).message);
    }
    this.jobs.set(job.id, job);
    this.requestIds.set(requestId, job.id);
    this.attach(job, child, action);
    this.audit({ event: "start", jobId: job.id, actionId, paramNames, pid: child.pid });
    void this.persist();
    void this.recordStartTime(job);
    return { ok: true, jobId: job.id };
  }

  private resolveCwd(action: Action, packDir: string, settings: RunnerSettings): string | undefined {
    if (action.cwd === undefined || action.cwd === "$PACK") return packDir;
    if (action.cwd === "$WORKSPACE") return settings.workspaceDir;
    return action.cwd;
  }

  private childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ENV_KEYS) {
      const value = this.opts.baseEnv[key];
      if (value !== undefined) env[key] = value;
    }
    return env;
  }

  private attach(job: Job, child: ChildProcess, action: Action): void {
    job.child = child;
    job.pid = child.pid;
    const ring = job.ring as RingBuffer;
    // Drain forever: after the ring is full old bytes are overwritten, so children never block.
    child.stdout?.on("data", (chunk: Buffer) => ring.write(chunk));
    child.stderr?.on("data", (chunk: Buffer) => ring.write(chunk));

    job.done = new Promise<void>((resolve) => {
      let finished = false;
      const finish = (code: number | null, signal: NodeJS.Signals | null, failure?: Error) => {
        if (finished) return;
        finished = true;
        job.cancelTimer?.();
        job.killTimer?.();
        job.endedAt = this.opts.now();
        if (failure) {
          job.state = job.reason ?? "failed";
          job.message = failure.message;
        } else if (job.reason) {
          job.state = job.reason;
        } else if (code === 0) {
          job.state = "succeeded";
        } else {
          job.state = "failed";
        }
        if (code !== null && !failure) job.exitCode = code;
        if (signal && !job.message) job.message = `terminated by ${signal}`;
        job.child = undefined;
        this.audit({ event: "finish", jobId: job.id, actionId: job.actionId, state: job.state, exitCode: job.exitCode });
        this.prune(job.actionId);
        void this.persist();
        resolve();
      };
      let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | undefined;
      child.once("error", (error) => finish(null, null, error));
      child.once("exit", (code, signal) => {
        exitInfo = { code, signal };
        // A descendant may keep the pipes open; do not wait for them forever.
        const cancelSettle = this.opts.schedule(() => finish(code, signal), this.opts.settleMs);
        child.once("close", () => {
          cancelSettle();
          finish(code, signal);
        });
      });
      child.once("close", (code, signal) => {
        if (!exitInfo) finish(code, signal);
      });
    });

    job.cancelTimer = this.opts.schedule(() => {
      if (job.state === "running") this.terminate(job, "timeout");
    }, action.timeout * 1000);
  }

  /** Mark why the job ends, then stop its whole process group: graceful first, forced after the grace. */
  private terminate(job: Job, reason: "timeout" | "cancelled"): void {
    job.reason ??= reason;
    const child = job.child;
    if (!child) return;
    this.signalGroup(child, job.pid, "SIGTERM");
    job.killTimer ??= this.opts.schedule(() => this.signalGroup(child, job.pid, "SIGKILL"), this.opts.graceMs);
  }

  private signalGroup(child: ChildProcess, pid: number | undefined, signal: NodeJS.Signals): void {
    // POSIX only: the child leads its own process group (detached), so -pid reaches every descendant.
    try {
      if (pid !== undefined) process.kill(-pid, signal);
      else child.kill(signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // Already gone.
      }
    }
  }

  private async recordStartTime(job: Job): Promise<void> {
    if (job.pid === undefined) return;
    const startTime = await this.opts.probe.startTime(job.pid);
    if (startTime === undefined || job.state !== "running") return;
    job.pidStartTime = startTime;
    await this.persist();
  }

  async cancel(jobId: string): Promise<CancelResult> {
    await this.init();
    const job = this.jobs.get(jobId);
    if (!job) return { ok: false, code: "not_found", message: `no job "${jobId}"` };
    if (job.state === "running") {
      this.audit({ event: "cancel", jobId, actionId: job.actionId });
      this.terminate(job, "cancelled");
      await job.done;
      return { ok: true, state: job.state };
    }
    if (job.state === "unknown" && job.pid !== undefined && job.pidStartTime !== undefined) {
      const { pid } = job;
      const verified =
        this.opts.probe.isAlive(pid) && (await this.opts.probe.startTime(pid)) === job.pidStartTime;
      if (!verified) {
        return { ok: false, code: "identity_unverified", message: "recorded process is gone or its identity changed" };
      }
      this.audit({ event: "cancel", jobId, actionId: job.actionId, orphan: true });
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        process.kill(pid, "SIGTERM");
      }
      job.state = "cancelled";
      job.endedAt = this.opts.now();
      job.message = "cancelled after restart";
      await this.persist();
      return { ok: true, state: "cancelled" };
    }
    return { ok: false, code: "not_running", message: `job "${jobId}" is ${job.state}` };
  }

  async get(jobId: string, cursor: number): Promise<JobView> {
    await this.init();
    const job = this.jobs.get(jobId);
    if (!job) {
      return { state: "unknown", message: "no such job", output: "", startCursor: cursor, nextCursor: cursor, truncated: false };
    }
    const view: JobView = {
      state: job.state,
      output: "",
      startCursor: cursor,
      nextCursor: cursor,
      truncated: false,
    };
    if (job.exitCode !== undefined) view.exitCode = job.exitCode;
    if (job.message !== undefined) view.message = job.message;
    const ring = job.ring;
    if (!ring) return view;
    const { data, start } = ring.read(cursor);
    let bytes = data;
    let skipped = 0;
    if (start > cursor || (start === ring.start && start > 0 && cursor < start)) {
      // The window moved past the cursor: realign to a character boundary.
      while (skipped < Math.min(3, bytes.length) && (bytes[skipped] & 0xc0) === 0x80) skipped++;
      bytes = bytes.subarray(skipped);
    }
    const length = job.state === "running" ? completeUtf8Length(bytes) : bytes.length;
    view.output = bytes.subarray(0, length).toString("utf8");
    view.startCursor = start + skipped;
    view.nextCursor = start + skipped + length;
    view.truncated = ring.truncated;
    return view;
  }

  /** Summaries of known jobs, newest first. */
  list(): PersistedJob[] {
    return [...this.jobs.values()].map(toPersisted).sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Terminate every running child and mark its job cancelled; resolves once they have ended. */
  async shutdown(): Promise<void> {
    const running = [...this.jobs.values()].filter((job) => job.state === "running");
    for (const job of running) {
      this.audit({ event: "cancel", jobId: job.id, actionId: job.actionId, reason: "plugin shutdown" });
      this.terminate(job, "cancelled");
    }
    await Promise.all(running.map((job) => job.done));
    await this.writeChain;
  }

  private prune(actionId: string): void {
    const finished = [...this.jobs.values()]
      .filter((job) => job.actionId === actionId && job.state !== "running")
      .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
    for (const job of finished.slice(FINISHED_JOBS_PER_ACTION)) {
      this.jobs.delete(job.id);
      if (this.requestIds.get(job.requestId) === job.id) this.requestIds.delete(job.requestId);
    }
  }

  private persist(): Promise<void> {
    const body = JSON.stringify({ version: 1, jobs: [...this.jobs.values()].map(toPersisted) });
    this.writeChain = this.writeChain.then(async () => {
      try {
        await mkdir(this.opts.dataDir, { recursive: true });
        const target = join(this.opts.dataDir, INDEX_FILE);
        const temp = `${target}.${process.pid}.tmp`;
        await writeFile(temp, body);
        await rename(temp, target);
      } catch {
        // The index is advisory; a failed write must not break running jobs.
      }
    });
    return this.writeChain;
  }

  /** Append one JSONL record. Callers pass param names only, never values. */
  private audit(record: Record<string, unknown>): void {
    const line = `${JSON.stringify({ ts: new Date(this.opts.now()).toISOString(), ...record })}\n`;
    this.writeChain = this.writeChain.then(async () => {
      try {
        await mkdir(this.opts.dataDir, { recursive: true });
        await appendFile(join(this.opts.dataDir, AUDIT_FILE), line);
      } catch {
        // Audit failures are not fatal to the job.
      }
    });
  }
}

function toPersisted(job: Job): PersistedJob {
  const out: PersistedJob = {
    id: job.id,
    actionId: job.actionId,
    requestId: job.requestId,
    state: job.state,
    startedAt: job.startedAt,
  };
  if (job.endedAt !== undefined) out.endedAt = job.endedAt;
  if (job.exitCode !== undefined) out.exitCode = job.exitCode;
  if (job.message !== undefined) out.message = job.message;
  if (job.pid !== undefined) out.pid = job.pid;
  if (job.pidStartTime !== undefined) out.pidStartTime = job.pidStartTime;
  return out;
}
