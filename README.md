# paseo-runner

A Paseo plugin that turns sets of scripts into tabs of buttons you can press from the desktop, the web UI or a phone.

**Status: scaffold.** The plugin does not run scripts yet. The decided v1 design is in [docs/DESIGN.md](docs/DESIGN.md).

## Contents

1. `index.*`, `client/`, `server/`, `shared/`: the `paseo plugin init` example, to be replaced by the runner.
2. `scripts/sync-plugins.mjs`: installs, disabled, every plugin that one of your daemons has onto the daemons that lack it.
   It is a dry run unless you pass `--apply`. Directory-sourced plugins can be given a portable source with
   `--source id=SOURCE`.

```bash
node scripts/sync-plugins.mjs                # plan across the local daemon and saved hosts
node scripts/sync-plugins.mjs --apply
```

Requires Paseo 0.14.0 or newer. Licence: MIT.
