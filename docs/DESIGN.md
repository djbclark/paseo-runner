# paseo-runner design (v1)

A Paseo plugin that turns sets of scripts into tabs of buttons, usable from desktop, web and phones. Execution always
happens on the daemon the client is pointed at; the app is only the UI.

Status: scaffold only. `index.*`, `client/`, `server/` and `shared/` still hold the `paseo plugin init` greeting example.
Nothing below is implemented yet.

## Decisions

1. **Packs reach the runner by local directories plus an optional spool file.**
   1. The runner reads explicit local pack directories from its own settings.
   2. A pack shipped as a plugin may also write a registration file into a spool directory in its server entry and remove it in
      cleanup. The file carries the pack root, manifest version, plugin id and the daemon PID; files whose PID is not the
      current daemon are ignored. The runner never scans `config.json` or sibling plugin directories: the install layout is
      not a contract.
   3. A pack is unapproved until the operator enables it in runner settings. The spool convention is an untested design;
      it is an adapter, so it can be replaced when Paseo offers a declared contribution point.
2. **v1 includes a basic terminal mode** next to capture mode. Terminal mode reports no success or failure: Paseo does not
   expose terminal exit codes to plugins.
3. **Default parameter pattern** is `^[A-Za-z0-9_./-]*$`, and a leading `-` is allowed. Authors wrapping CLIs should add their
   own pattern or put `--` before values.
4. **Upstream.** File a `contributes` manifest field plus a plugin-list API proposal after v1 ships. Search issues first.
5. `scripts/sync-plugins.mjs` lives here: it installs missing plugins onto other daemons, disabled.

## Action model

`{id: "<pack>/<local>", title, tab, icon, argv | shell, cwd, params[], confirm, timeout, mode: capture|terminal}`

1. `argv` is the normal form. Parameter values fill whole argv elements and never enter shell text.
2. `cwd` is absolute, `$PACK` or `$WORKSPACE`. Relative is rejected.
3. Parameter types: string, int, enum, bool, secretRef (resolved by an external broker at run time, never stored or logged).
4. `confirm` defaults to true. Authors opt out.
5. Concurrency is one active job per action by default.

## Execution (capture mode)

Job IDs and polling, not streaming: `start(actionId, values, requestId) -> jobId`, `getJob(jobId, cursor)`, `cancel(jobId)`.
Output is capped per job. A daemon restart marks unfinished jobs `unknown`; the runner never invents an exit status and
never retries. Children are killed only after the process identity is verified.

## Security

Any authorized client, a phone over relay included, can call the runner's RPCs, so:

1. The RPC accepts an action id and typed values, never a command string.
2. Allow and deny lists are enforced on the server. Disabled packs run nothing.
3. Every start, denial and cancellation goes to an audit log with secrets redacted.
4. A pack is trusted code. Disabling it in the runner is not a sandbox.

## Formats

1. Native manifest: JSON with `schemaVersion: 1`, validated with zod; unknown versions and unknown execution fields are rejected.
2. Directory adapter: executables with Raycast-style header comments. A convenience subset, not a compatibility promise.
3. OliveTin importer: reads YAML fragments. It maps `exec:` and literal commands, dashboards to tabs, and the basic argument
   types. It refuses `shell:` with interpolation, entities, triggers, rate limits, checklist and datetime, and says why.
4. Out of v1: justfile and `package.json` adapters, entities, chaining, scheduling.

## First tests

1. Parameter values stay literal argv; invalid, stale or disabled actions are rejected before spawn.
2. Repeated starts produce one job; output stays bounded; cancel reaches descendants; restart reports `unknown`.
3. OliveTin fixtures import supported behavior and refuse unsupported behavior with precise diagnostics.
