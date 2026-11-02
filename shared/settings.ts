import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

const absolutePath = z.string().regex(/^(\/|[A-Za-z]:[\\/])/, "Enter an absolute path");

export const runnerSettings = defineSettings({
  id: "runner",
  scope: "host",
  version: 1,
  schema: z.object({
    /** Absolute directories searched (one level) for `*.runner.json` and `paseo-runner.json`. */
    packDirs: z.array(absolutePath).default([]),
    /** Approvals keyed by pack name; `hash` is the SHA-256 of the canonical manifest. */
    approvedPacks: z
      .record(z.string(), z.object({ hash: z.string(), disabled: z.boolean().default(false) }))
      .default({}),
    /** Directory that `$WORKSPACE` resolves to. Actions using it are denied while unset. */
    workspaceDir: absolutePath.optional(),
  }),
});
export type RunnerSettings = z.output<typeof runnerSettings.schema>;
