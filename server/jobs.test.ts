import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobManager, OUTPUT_CAP_BYTES, type Spawner } from "./jobs";
import type { LoadedPack, PackLoad } from "./packs";
import { parseManifest } from "../shared/schema";

const NODE = process.execPath;
const PACK_DIR = tmpdir();
let dir: string;
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "runner-test-"));
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  await rm(dir, { recursive: true, force: true });
});

function pack(actions: unknown[], flags: Partial<Pick<LoadedPack, "approved" | "disabled">> = {}): PackLoad {
  const parsed = parseManifest({ schemaVersion: 1, name: "demo", actions });
  if (!parsed.ok) throw new Error(parsed.reason);
  return {
    packs: [{ manifest: parsed.manifest, path: join(PACK_DIR, "demo.runner.json"), dir: PACK_DIR, hash: "h", approved: true, disabled: false, ...flags }],
    refused: [],
  };
}

function nodeAction(id: string, script: string, extra: Record<string, unknown> = {}) {
  return { id, title: id, argv: [NODE, "-e", script], confirm: false, ...extra };
}

function setup(load: PackLoad, options: { schedule?: (fn: () => void, ms: number) => () => void } = {}) {
  const spawner = vi.fn<Spawner>((command, args, opts) => spawn(command, args, opts));
  const manager = new JobManager({
    dataDir: dir,
    spawner,
    loadPacks: async () => load,
    readSettings: async () => ({ settings: { packDirs: [], approvedPacks: {} } }),
    now: () => 1_000,
    graceMs: 200,
    settleMs: 100,
    ...options,
  });
  cleanups.push(() => manager.shutdown());
  return { manager, spawner };
}

async function finished(manager: JobManager, jobId: string) {
  for (let i = 0; i < 400; i++) {
    const view = await manager.get(jobId, 0);
    if (view.state !== "running") return view;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("job did not finish");
}

async function started(manager: JobManager, actionId: string, extra: Record<string, unknown> = {}) {
  const result = await manager.start({ actionId, values: {}, requestId: `r-${Math.random()}`, confirmed: true, ...extra });
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.jobId;
}

describe("starts rejected before spawn", () => {
  const cases: Array<[string, PackLoad, Record<string, unknown>, string]> = [
    ["unknown action", pack([nodeAction("a", "0")]), { actionId: "demo/missing" }, "unknown_action"],
    ["unapproved pack", pack([nodeAction("a", "0")], { approved: false }), {}, "not_approved"],
    ["disabled pack", pack([nodeAction("a", "0")], { disabled: true }), {}, "disabled"],
    ["unconfirmed action", pack([nodeAction("a", "0", { confirm: true })]), { confirmed: false }, "confirmation_required"],
    [
      "invalid params",
      pack([{ id: "a", title: "a", argv: [NODE, "{{p}}"], params: [{ name: "p", type: "string" }], confirm: false }]),
      { values: { p: "$(x)" } },
      "invalid_params",
    ],
  ];
  it.each(cases)("%s", async (_name, load, overrides, code) => {
    const { manager, spawner } = setup(load);
    const result = await manager.start({ actionId: "demo/a", values: {}, requestId: "r1", confirmed: true, ...overrides });
    expect(result).toMatchObject({ ok: false, code });
    expect(spawner).not.toHaveBeenCalled();
  });

  it("writes denials to the audit log without param values", async () => {
    const load = pack([{ id: "a", title: "a", argv: [NODE, "{{p}}"], params: [{ name: "p", type: "string" }], confirm: false }]);
    const { manager } = setup(load);
    await manager.start({ actionId: "demo/a", values: { p: "$(secret)" }, requestId: "r1", confirmed: true });
    await manager.shutdown();
    const audit = await readFile(join(dir, "audit.jsonl"), "utf8");
    expect(audit).toContain('"event":"denied"');
    expect(audit).toContain('"paramNames":["p"]');
    expect(audit).not.toContain("secret");
  });
});

describe("job lifecycle with a real child", () => {
  it("reports exit code and reads output by cursor", async () => {
    const { manager } = setup(pack([nodeAction("a", 'console.log("one"); setTimeout(()=>{console.error("two"); process.exit(3)}, 50)')]));
    const view = await finished(manager, await started(manager, "demo/a"));
    expect(view).toMatchObject({ state: "failed", exitCode: 3, output: "one\ntwo\n", truncated: false });
    const tail = await manager.get((manager.list()[0]).id, 4);
    expect(tail).toMatchObject({ output: "two\n", startCursor: 4, nextCursor: 8 });
    expect(await manager.get(manager.list()[0].id, view.nextCursor)).toMatchObject({ output: "", nextCursor: 8 });
  });

  it("caps output and keeps draining so the child still exits", async () => {
    const total = 600 * 1024;
    const { manager } = setup(pack([nodeAction("a", `process.stdout.write("x".repeat(${total}))`)]));
    const view = await finished(manager, await started(manager, "demo/a"));
    expect(view.state).toBe("succeeded");
    expect(view.exitCode).toBe(0);
    expect(view.truncated).toBe(true);
    expect(view.nextCursor).toBe(total);
    expect(view.startCursor).toBe(total - OUTPUT_CAP_BYTES);
    expect(view.output.length).toBe(OUTPUT_CAP_BYTES);
  });

  it("kills the child when the timeout fires", async () => {
    const timers: Array<{ ms: number; fn: () => void }> = [];
    const schedule = (fn: () => void, ms: number) => {
      timers.push({ ms, fn });
      return () => undefined;
    };
    const { manager } = setup(pack([nodeAction("a", "setInterval(()=>{}, 1000)", { timeout: 5 })]), { schedule });
    const jobId = await started(manager, "demo/a");
    timers.find((timer) => timer.ms === 5000)?.fn();
    // The injected scheduler never fires the settle timer, so the real exit and close events end the job.
    expect((await finished(manager, jobId)).state).toBe("timeout");
  });

  it("cancel kills a child and its grandchild", async () => {
    const script = `const c=require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"inherit"});console.log(c.pid);setInterval(()=>{},1000)`;
    const { manager } = setup(pack([nodeAction("a", script)]));
    const jobId = await started(manager, "demo/a");
    let grandchild = 0;
    for (let i = 0; i < 200 && !grandchild; i++) {
      grandchild = Number((await manager.get(jobId, 0)).output.trim());
      if (!grandchild) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(grandchild).toBeGreaterThan(0);
    expect(await manager.cancel(jobId)).toEqual({ ok: true, state: "cancelled" });
    let alive = true;
    for (let i = 0; i < 100 && alive; i++) {
      try {
        process.kill(grandchild, 0);
        await new Promise((resolve) => setTimeout(resolve, 25));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });

  it("returns the same job for a repeated requestId and refuses a second concurrent run", async () => {
    const { manager, spawner } = setup(pack([nodeAction("a", "setInterval(()=>{}, 1000)")]));
    const first = await manager.start({ actionId: "demo/a", values: {}, requestId: "same", confirmed: true });
    const again = await manager.start({ actionId: "demo/a", values: {}, requestId: "same", confirmed: true });
    expect(again).toEqual(first);
    expect(spawner).toHaveBeenCalledTimes(1);
    const other = await manager.start({ actionId: "demo/a", values: {}, requestId: "other", confirmed: true });
    expect(other).toMatchObject({ ok: false, code: "already_running", jobId: first.ok ? first.jobId : "" });
  });

  it("turns a persisted running job into unknown on restart without killing it", async () => {
    const survivor = spawn(NODE, ["-e", "setInterval(()=>{}, 1000)"], { stdio: "ignore" });
    cleanups.push(() => void survivor.kill("SIGKILL"));
    await writeFile(
      join(dir, "jobs.json"),
      JSON.stringify({
        version: 1,
        jobs: [{ id: "old", actionId: "demo/a", requestId: "r", state: "running", startedAt: 1, pid: survivor.pid, pidStartTime: "x" }],
      }),
    );
    const { manager, spawner } = setup(pack([nodeAction("a", "0")]));
    expect(await manager.get("old", 0)).toMatchObject({ state: "unknown", message: "interrupted by restart" });
    expect(await manager.cancel("old")).toMatchObject({ ok: false, code: "identity_unverified" });
    expect(() => process.kill(survivor.pid as number, 0)).not.toThrow();
    expect(spawner).not.toHaveBeenCalled();
    const index = JSON.parse(await readFile(join(dir, "jobs.json"), "utf8"));
    expect(index.jobs[0].state).toBe("unknown");
  });
});
