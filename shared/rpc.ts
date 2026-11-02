import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { ParamSchema } from "./schema";

const ActionInfo = z.object({
  id: z.string(),
  localId: z.string(),
  title: z.string(),
  tab: z.string().optional(),
  icon: z.string().optional(),
  params: z.array(ParamSchema),
  confirm: z.boolean(),
  timeout: z.number(),
  concurrency: z.enum(["single", "parallel"]),
  mode: z.literal("capture"),
});

const PackInfo = z.object({
  name: z.string(),
  title: z.string().optional(),
  approved: z.boolean(),
  disabled: z.boolean(),
  hash: z.string(),
  path: z.string(),
  tabs: z.array(z.string()),
  actions: z.array(ActionInfo),
});

export const listRpc = defineRpc({
  name: "runner.packs.list",
  input: z.object({}),
  output: z.object({
    packs: z.array(PackInfo),
    refused: z.array(z.object({ path: z.string(), reason: z.string() })),
  }),
});

export const START_ERROR_CODES = [
  "invalid_settings",
  "unknown_action",
  "not_approved",
  "disabled",
  "confirmation_required",
  "already_running",
  "invalid_params",
  "workspace_unset",
  "request_id_conflict",
  "spawn_failed",
] as const;

export const startRpc = defineRpc({
  name: "runner.job.start",
  input: z.object({
    actionId: z.string().min(1).max(200),
    values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
    requestId: z.string().min(1).max(200),
    confirmed: z.boolean().default(false),
  }),
  output: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), jobId: z.string() }),
    z.object({
      ok: z.literal(false),
      code: z.enum(START_ERROR_CODES),
      message: z.string(),
      jobId: z.string().optional(),
    }),
  ]),
});

export const JOB_STATES = ["running", "succeeded", "failed", "timeout", "cancelled", "unknown"] as const;

export const getRpc = defineRpc({
  name: "runner.job.get",
  input: z.object({ jobId: z.string().min(1), cursor: z.number().int().min(0).default(0) }),
  output: z.object({
    state: z.enum(JOB_STATES),
    exitCode: z.number().int().optional(),
    message: z.string().optional(),
    /** UTF-8 text of the combined stdout and stderr from `startCursor` to `nextCursor`. */
    output: z.string(),
    startCursor: z.number().int(),
    nextCursor: z.number().int(),
    /** True once the job produced more than the per-job cap and the oldest bytes were dropped. */
    truncated: z.boolean(),
  }),
});

export const cancelRpc = defineRpc({
  name: "runner.job.cancel",
  input: z.object({ jobId: z.string().min(1) }),
  output: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), state: z.enum(JOB_STATES) }),
    z.object({
      ok: z.literal(false),
      code: z.enum(["not_found", "not_running", "identity_unverified"]),
      message: z.string(),
    }),
  ]),
});
