# paseo-runner

A Paseo plugin that turns sets of scripts into tabs of buttons you can press from the desktop, the web UI or a phone.

**Status: stage 1 (server core).** The plugin runs approved, typed actions in capture mode through its RPCs. It has no UI yet.
The decided design is in [docs/DESIGN.md](docs/DESIGN.md).

## Contents

1. `index.server.ts`, `server/`, `shared/`: manifest schema, pack loader with hash approval, job manager and RPC contracts.
   Pack directories and approvals are set in the runner's plugin settings. `npm test` runs the vitest suites.
2. `scripts/sync-plugins.mjs`: installs, disabled, every plugin that one of your daemons has onto the daemons that lack it.
   It is a dry run unless you pass `--apply`. Directory-sourced plugins can be given a portable source with
   `--source id=SOURCE`.

```bash
node scripts/sync-plugins.mjs                # plan across the local daemon and saved hosts
node scripts/sync-plugins.mjs --apply
```

Requires Paseo 0.14.0 or newer. Process-group handling is POSIX only. Licence: MIT.
