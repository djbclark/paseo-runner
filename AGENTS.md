# paseo-runner

`CLAUDE.md` is a symlink to this file. What it is: `README.md`. Decided design: `docs/DESIGN.md`; read it before changing anything.

1. `npm run typecheck` before every commit. Server code lives in `server/` (and `index.server.ts`), client code, when it exists, in `client/`, shared zod contracts in `shared/`; the entries stay registration wiring.
2. The RPC takes an action id and typed values, never a command string. Do not add one.
3. Reload after source edits: `paseo plugin reload paseo-runner`. Never restart the main daemon.
4. Heavy test runs go to CI, not the Mac; run single files with `npx vitest run <file> --bail=1`.
5. `docs/DESIGN.md` describes the present decision, not history. Update it when a decision changes.
