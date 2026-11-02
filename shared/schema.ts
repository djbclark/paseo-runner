import { z } from "zod";

export const DEFAULT_STRING_PATTERN = "^[A-Za-z0-9_./-]*$";
export const MAX_TIMEOUT_SECONDS = 3600;

const LOCAL_ID = /^[a-z0-9][a-z0-9_-]*$/;
const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PLACEHOLDER = /^\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}$/;
const ABSOLUTE_PATH = /^(\/|[A-Za-z]:[\\/])/;

/** The param name when `element` is exactly one `{{param}}` placeholder, otherwise undefined. */
export function placeholderName(element: string): string | undefined {
  return PLACEHOLDER.exec(element)?.[1];
}

export const ParamSchema = z
  .object({
    name: z.string().regex(PARAM_NAME, "param name must match [A-Za-z_][A-Za-z0-9_]*"),
    label: z.string().min(1).optional(),
    type: z.enum(["string", "int", "enum", "bool", "secretRef"]),
    required: z.boolean().default(true),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    pattern: z.string().optional(),
    choices: z.array(z.string()).min(1).optional(),
    min: z.number().int().optional(),
    max: z.number().int().optional(),
  })
  .strict();
export type Param = z.output<typeof ParamSchema>;

export const ActionSchema = z
  .object({
    id: z.string().regex(LOCAL_ID, "action id must match [a-z0-9][a-z0-9_-]*"),
    title: z.string().min(1),
    tab: z.string().min(1).optional(),
    icon: z.string().min(1).optional(),
    argv: z.array(z.string()).min(1),
    cwd: z.string().optional(),
    params: z.array(ParamSchema).default([]),
    confirm: z.boolean().default(true),
    timeout: z.number().int().min(1).max(MAX_TIMEOUT_SECONDS).default(60),
    mode: z.literal("capture").default("capture"),
    concurrency: z.enum(["single", "parallel"]).default("single"),
  })
  .strict();
export type Action = z.output<typeof ActionSchema>;

function checkParam(action: string, param: Param): string | undefined {
  const where = `action "${action}" param "${param.name}"`;
  if (param.type === "secretRef") {
    return `${where}: secretRef params are not supported yet; remove it from action "${action}"`;
  }
  if (param.type === "enum" && !param.choices) return `${where}: enum requires choices`;
  if (param.type !== "enum" && param.choices) return `${where}: choices only apply to enum`;
  if (param.type !== "int" && (param.min !== undefined || param.max !== undefined)) {
    return `${where}: min/max only apply to int`;
  }
  if (param.type !== "string" && param.pattern !== undefined) {
    return `${where}: pattern only applies to string`;
  }
  if (param.pattern !== undefined) {
    try {
      new RegExp(param.pattern);
    } catch {
      return `${where}: pattern is not a valid regular expression`;
    }
  }
  if (param.min !== undefined && param.max !== undefined && param.min > param.max) {
    return `${where}: min exceeds max`;
  }
  return undefined;
}

function checkAction(action: Action): string | undefined {
  const names = new Set<string>();
  for (const param of action.params) {
    if (names.has(param.name)) return `action "${action.id}": duplicate param "${param.name}"`;
    names.add(param.name);
    const problem = checkParam(action.id, param);
    if (problem) return problem;
  }
  if (action.cwd !== undefined) {
    const ok = action.cwd === "$PACK" || action.cwd === "$WORKSPACE" || ABSOLUTE_PATH.test(action.cwd);
    if (!ok) {
      return `action "${action.id}": cwd must be absolute, "$PACK" or "$WORKSPACE" (got "${action.cwd}")`;
    }
  }
  for (const [index, element] of action.argv.entries()) {
    const name = placeholderName(element);
    if (name === undefined) {
      if (element.includes("{{") || element.includes("}}")) {
        return `action "${action.id}": argv[${index}] embeds a placeholder; a {{param}} must be a whole argv element`;
      }
      continue;
    }
    if (index === 0) return `action "${action.id}": argv[0] must be a fixed executable, not a placeholder`;
    if (!names.has(name)) return `action "${action.id}": argv[${index}] references undeclared param "${name}"`;
  }
  return undefined;
}

export const PackManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: z.string().regex(LOCAL_ID, "pack name must match [a-z0-9][a-z0-9_-]*"),
    title: z.string().min(1).optional(),
    tabs: z.array(z.string().min(1)).optional(),
    actions: z.array(ActionSchema),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const ids = new Set<string>();
    for (const action of manifest.actions) {
      if (ids.has(action.id)) {
        ctx.addIssue({ code: "custom", message: `duplicate action id "${action.id}"` });
      }
      ids.add(action.id);
      const problem = checkAction(action);
      if (problem) ctx.addIssue({ code: "custom", message: problem });
    }
  });
export type PackManifest = z.output<typeof PackManifestSchema>;

export type ManifestResult = { ok: true; manifest: PackManifest } | { ok: false; reason: string };

/** Validate untrusted manifest JSON into a typed manifest or one human-readable reason. */
export function parseManifest(raw: unknown): ManifestResult {
  const result = PackManifestSchema.safeParse(raw);
  if (result.success) return { ok: true, manifest: result.data };
  const reason = result.error.issues
    .map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
    .join("; ");
  return { ok: false, reason };
}

export function qualifiedId(pack: string, localId: string): string {
  return `${pack}/${localId}`;
}
