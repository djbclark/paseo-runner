import { homedir } from "node:os";
import { join } from "node:path";
import { spawnProcess, type PluginServerContext } from "@getpaseo/plugin/server";
import { JobManager, type SettingsSnapshot } from "./server/jobs";
import { loadPacks } from "./server/packs";
import { cancelRpc, getRpc, listRpc, startRpc } from "./shared/rpc";
import { runnerSettings } from "./shared/settings";

// $PASEO_HOME is not part of the documented plugin context; read it from the environment when the
// host passes it down and fall back to ~/.paseo, the default daemon home.
function dataDir(): string {
  const home = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  return join(home, "plugin-data", "paseo-runner");
}

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(runnerSettings);

  async function readSettings(): Promise<SettingsSnapshot> {
    const state = await settings.read();
    return state.status === "ready" ? { settings: state.values } : { settings: undefined, error: state.error };
  }

  async function currentPacks() {
    const snapshot = await readSettings();
    if (!snapshot.settings) {
      return { packs: [], refused: [{ path: "settings", reason: snapshot.error ?? "runner settings are invalid" }] };
    }
    return loadPacks(snapshot.settings);
  }

  const jobs = new JobManager({
    dataDir: dataDir(),
    spawner: (command, args, options) => spawnProcess(command, args, options),
    loadPacks: currentPacks,
    readSettings,
  });
  void jobs.init();

  server.handle(listRpc, async () => {
    const { packs, refused } = await currentPacks();
    return {
      packs: packs.map((pack) => ({
        name: pack.manifest.name,
        title: pack.manifest.title,
        approved: pack.approved,
        disabled: pack.disabled,
        hash: pack.hash,
        path: pack.path,
        tabs: pack.manifest.tabs ?? [],
        actions: pack.manifest.actions.map((action) => ({
          id: `${pack.manifest.name}/${action.id}`,
          localId: action.id,
          title: action.title,
          tab: action.tab,
          icon: action.icon,
          params: action.params,
          confirm: action.confirm,
          timeout: action.timeout,
          concurrency: action.concurrency,
          mode: action.mode,
        })),
      })),
      refused,
    };
  });
  server.handle(startRpc, (input) => jobs.start(input));
  server.handle(getRpc, (input) => jobs.get(input.jobId, input.cursor));
  server.handle(cancelRpc, (input) => jobs.cancel(input.jobId));

  return () => jobs.shutdown();
}
