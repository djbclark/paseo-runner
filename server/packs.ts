import { createHash } from "node:crypto";
import { readdir, readFile, realpath } from "node:fs/promises";
import { join, relative, isAbsolute, sep } from "node:path";
import { parseManifest, qualifiedId, type Action, type PackManifest } from "../shared/schema";
import type { RunnerSettings } from "../shared/settings";

export interface LoadedPack {
  manifest: PackManifest;
  /** Real path of the manifest file. */
  path: string;
  /** Real path of the pack directory; `$PACK` resolves here. */
  dir: string;
  hash: string;
  approved: boolean;
  disabled: boolean;
}

export interface Refused {
  path: string;
  reason: string;
}

export interface PackLoad {
  packs: LoadedPack[];
  refused: Refused[];
}

export function isManifestFile(name: string): boolean {
  return name === "paseo-runner.json" || name.endsWith(".runner.json");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** SHA-256 over the key-sorted JSON of the manifest, so whitespace and key order do not matter. */
export function hashManifest(raw: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(raw))).digest("hex");
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && !rel.startsWith(`..${sep}`);
}

function usesPackCwd(manifest: PackManifest): boolean {
  return manifest.actions.some((action) => action.cwd === "$PACK");
}

/** Load every manifest from the configured pack directories. Never throws for bad packs. */
export async function loadPacks(settings: Pick<RunnerSettings, "packDirs" | "approvedPacks">): Promise<PackLoad> {
  const packs: LoadedPack[] = [];
  const refused: Refused[] = [];
  const seenIds = new Map<string, string>();
  const seenFiles = new Set<string>();

  for (const configured of settings.packDirs) {
    let dir: string;
    let names: string[];
    try {
      dir = await realpath(configured);
      names = (await readdir(dir)).filter(isManifestFile).sort();
    } catch (error) {
      refused.push({ path: configured, reason: `cannot read pack directory: ${(error as Error).message}` });
      continue;
    }
    for (const name of names) {
      const declared = join(dir, name);
      let path: string;
      try {
        path = await realpath(declared);
      } catch (error) {
        refused.push({ path: declared, reason: `cannot resolve manifest: ${(error as Error).message}` });
        continue;
      }
      if (seenFiles.has(path)) continue;
      seenFiles.add(path);

      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(path, "utf8"));
      } catch (error) {
        refused.push({ path, reason: `cannot read manifest: ${(error as Error).message}` });
        continue;
      }
      const parsed = parseManifest(raw);
      if (!parsed.ok) {
        refused.push({ path, reason: parsed.reason });
        continue;
      }
      const { manifest } = parsed;
      if (usesPackCwd(manifest) && !isInside(dir, path)) {
        refused.push({
          path,
          reason: `manifest resolves outside its pack directory (${dir}) and an action uses cwd "$PACK"`,
        });
        continue;
      }
      const clash = manifest.actions
        .map((action) => qualifiedId(manifest.name, action.id))
        .find((id) => seenIds.has(id));
      if (clash) {
        refused.push({ path, reason: `duplicate action id "${clash}" already defined by ${seenIds.get(clash)}` });
        continue;
      }
      for (const action of manifest.actions) seenIds.set(qualifiedId(manifest.name, action.id), path);

      const hash = hashManifest(raw);
      const approval = Object.hasOwn(settings.approvedPacks, manifest.name)
        ? settings.approvedPacks[manifest.name]
        : undefined;
      packs.push({
        manifest,
        path,
        dir,
        hash,
        approved: approval !== undefined && approval.hash === hash,
        disabled: approval?.disabled ?? false,
      });
    }
  }
  return { packs, refused };
}

export interface FoundAction {
  pack: LoadedPack;
  action: Action;
}

export function findAction(load: PackLoad, id: string): FoundAction | undefined {
  const slash = id.indexOf("/");
  if (slash <= 0) return undefined;
  const packName = id.slice(0, slash);
  const localId = id.slice(slash + 1);
  for (const pack of load.packs) {
    if (pack.manifest.name !== packName) continue;
    const action = pack.manifest.actions.find((candidate) => candidate.id === localId);
    if (action) return { pack, action };
  }
  return undefined;
}

