#!/usr/bin/env node
// Install every plugin that any of your daemons has onto every daemon missing it, then disable
// the new copy. Phones and other pure clients follow: they load plugin client bundles from the
// daemon they connect to, so a plugin installed (even disabled) on that daemon shows up there
// once you enable it.
//
// Dry run by default. `--apply` installs. Directory-sourced plugins are machine-local paths and
// are reported, never copied. Installing runs the plugin's preparation commands and, when the
// target has `pluginsEnabled: true`, briefly starts it before the disable lands.
//
//   node scripts/sync-plugins.mjs                        # plan across local + saved hosts
//   node scripts/sync-plugins.mjs --apply
//   node scripts/sync-plugins.mjs --host wss://box:7263 --no-discover   # explicit targets only
//
// `--source id=SOURCE` supplies the install source for a plugin whose local installation is a
// directory (for example `--source my-plugin=git:owner/repo:plugin`); it wins over detection.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const PASEO = process.env.PASEO_BIN ?? "paseo";
const DEFAULT_REGISTRY = "https://plugins.paseo.sh";
const TIMEOUT_MS = 180_000;

function parseArgs(argv) {
  const opts = {
    apply: false,
    json: false,
    local: true,
    discover: true,
    hosts: [],
    only: [],
    exclude: [],
    sources: new Map(),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[(i += 1)];
      if (!next) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--apply") opts.apply = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--no-local") opts.local = false;
    else if (arg === "--no-discover") opts.discover = false;
    else if (arg === "--host") opts.hosts.push(value());
    else if (arg === "--only") opts.only.push(value());
    else if (arg === "--exclude") opts.exclude.push(value());
    else if (arg === "--source") {
      const [id, ...rest] = value().split("=");
      if (!id || rest.length === 0) throw new Error("--source needs id=SOURCE");
      opts.sources.set(id, rest.join("="));
    }
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

async function paseo(hostArgs, args) {
  const { stdout } = await run(PASEO, [...hostArgs, ...args, "--json"], {
    timeout: TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

// The CLI prints a trust banner on stderr before its JSON error, so look for the JSON object in
// stdout, then in stderr from its first "{", before falling back to the last stderr line.
function errorText(error) {
  for (const stream of [`${error.stdout ?? ""}`, `${error.stderr ?? ""}`]) {
    const start = stream.indexOf("{");
    if (start === -1) continue;
    try {
      const parsed = JSON.parse(stream.slice(start));
      const message = parsed?.error?.userMessage ?? parsed?.error?.message;
      if (message) return message;
    } catch {
      // not JSON; try the next stream
    }
  }
  const lines = `${error.stderr ?? ""}`.trim().split("\n");
  return lines[lines.length - 1] || error.message;
}

// Source string accepted by `paseo plugin install`, or null when it only exists on one machine.
export function portableSource(installation) {
  const identity = installation?.identity;
  if (!identity) return null;
  const suffix = identity.pluginPath && identity.pluginPath !== "." ? `:${identity.pluginPath}` : "";
  if (identity.registry) {
    const url = new URL(identity.registry.url);
    if (url.origin !== identity.registry.url.replace(/\/+$/, "")) return null;
    return identity.registry.url.replace(/\/+$/, "") === DEFAULT_REGISTRY
      ? identity.registry.id
      : `${url.host}/${identity.registry.id}`;
  }
  if (identity.kind === "npm") return `npm:${identity.packageName}${suffix}`;
  if (identity.kind === "git") return `${identity.remote}${suffix}`;
  return null;
}

async function discoverTargets(opts) {
  const targets = [];
  if (opts.local) targets.push({ name: "local", hostArgs: [] });
  for (const host of opts.hosts) targets.push({ name: host, hostArgs: ["--host", host] });
  if (opts.discover && opts.local) {
    try {
      for (const saved of await paseo([], ["host", "ls"])) {
        if (!saved.enabled || !saved.targetDescription) continue;
        if (opts.hosts.includes(saved.targetDescription)) continue;
        targets.push({
          name: saved.label ?? saved.targetDescription,
          hostArgs: ["--host", saved.targetDescription],
        });
      }
    } catch (error) {
      process.stderr.write(`host discovery failed: ${errorText(error)}\n`);
    }
  }
  return targets;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const wanted = (id) =>
    (opts.only.length === 0 || opts.only.includes(id)) && !opts.exclude.includes(id);

  const targets = await discoverTargets(opts);
  if (targets.length < 2) throw new Error("Need at least two daemons to sync.");

  const unreachable = [];
  const reachable = [];
  await Promise.all(
    targets.map(async (target) => {
      try {
        target.plugins = await paseo(target.hostArgs, ["plugin", "ls"]);
        reachable.push(target);
      } catch (error) {
        unreachable.push({ host: target.name, error: errorText(error) });
      }
    }),
  );
  reachable.sort((a, b) => targets.indexOf(a) - targets.indexOf(b));

  // id -> { source, from }. First portable source in target order wins; differing ones are noted.
  const catalog = new Map();
  const localOnly = new Map();
  const conflicts = [];
  for (const target of reachable) {
    for (const plugin of target.plugins) {
      if (!wanted(plugin.id)) continue;
      const source = opts.sources.get(plugin.id) ?? portableSource(plugin.installation);
      if (!source) {
        if (!localOnly.has(plugin.id)) localOnly.set(plugin.id, target.name);
        continue;
      }
      const known = catalog.get(plugin.id);
      if (!known) catalog.set(plugin.id, { source, from: target.name });
      else if (known.source !== source)
        conflicts.push({ id: plugin.id, kept: known, other: { source, from: target.name } });
    }
  }

  const results = [];
  for (const target of reachable) {
    const have = new Set(target.plugins.map((plugin) => plugin.id));
    for (const [id, { source, from }] of catalog) {
      if (have.has(id)) continue;
      const row = { host: target.name, id, source, from, outcome: "planned" };
      results.push(row);
      if (!opts.apply) continue;
      try {
        await paseo(target.hostArgs, ["plugin", "install", source, "--id", id]);
      } catch (error) {
        row.outcome = "install-failed";
        row.error = errorText(error);
        continue;
      }
      try {
        await paseo(target.hostArgs, ["plugin", "disable", id]);
        row.outcome = "installed-disabled";
      } catch (error) {
        row.outcome = "INSTALLED-BUT-STILL-ENABLED";
        row.error = errorText(error);
      }
    }
  }
  const skipped = [...localOnly]
    .filter(([id]) => !catalog.has(id))
    .map(([id, from]) => ({ id, from, reason: "directory source, not portable" }));

  const failed =
    unreachable.length > 0 ||
    results.some((row) => row.outcome !== "planned" && row.outcome !== "installed-disabled");

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({ apply: opts.apply, results, skipped, conflicts, unreachable }, null, 2)}\n`,
    );
  } else {
    const lines = [];
    lines.push(`${opts.apply ? "APPLY" : "DRY RUN"}: ${reachable.map((t) => t.name).join(", ")}`);
    for (const row of results)
      lines.push(
        `${row.outcome.padEnd(20)} ${row.host}: ${row.id}  <- ${row.source} (seen on ${row.from})${row.error ? `\n    ${row.error}` : ""}`,
      );
    if (results.length === 0) lines.push("nothing to install");
    for (const item of skipped) lines.push(`skipped              ${item.id} (${item.reason}, on ${item.from})`);
    for (const item of conflicts)
      lines.push(
        `conflict             ${item.id}: using ${item.kept.source} (${item.kept.from}), ignoring ${item.other.source} (${item.other.from})`,
      );
    for (const item of unreachable) lines.push(`UNREACHABLE          ${item.host}: ${item.error}`);
    if (!opts.apply && results.length > 0) lines.push("re-run with --apply to install");
    process.stdout.write(`${lines.join("\n")}\n`);
  }
  if (failed) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  });
}
