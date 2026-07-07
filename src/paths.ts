import { mkdir, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppPaths, SavePaths } from "./types.ts";

export function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return path.join(homedir(), input.slice(2));
  return input;
}

export function defaultAppDataRoot(): string {
  if (process.env.PI_TAVERN_HOME) return path.resolve(expandHome(process.env.PI_TAVERN_HOME));
  if (process.env.XDG_DATA_HOME) return path.resolve(expandHome(process.env.XDG_DATA_HOME), "pi-tavern");
  return path.join(homedir(), ".local", "share", "pi-tavern");
}

export function getAppPaths(root = defaultAppDataRoot()): AppPaths {
  const resolved = path.resolve(expandHome(root));
  return {
    root: resolved,
    piHome: path.join(resolved, "pi-home"),
    characters: path.join(resolved, "characters"),
    saves: path.join(resolved, "saves"),
  };
}

export function getSavePaths(saveRoot: string): SavePaths {
  const root = path.resolve(expandHome(saveRoot));
  return {
    root,
    piSession: path.join(root, "pi-session"),
    world: path.join(root, "world"),
    manifest: path.join(root, "manifest.json"),
    meta: path.join(root, "meta.json"),
  };
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function ensureAppDirs(paths: AppPaths): Promise<void> {
  await Promise.all([ensureDir(paths.root), ensureDir(paths.piHome), ensureDir(paths.characters), ensureDir(paths.saves)]);
}

export function slugify(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "save";
}

export function timestampId(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(
    date.getUTCHours(),
  )}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

export function makeSaveId(characterName: string, date = new Date()): string {
  return `${slugify(characterName)}-${timestampId(date)}`;
}

export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

export async function realpathIfExists(p: string): Promise<string | undefined> {
  try {
    return await realpath(p);
  } catch {
    return undefined;
  }
}

export function exists(p: string): boolean {
  return existsSync(p);
}

export function fromHere(metaUrl: string, relative: string): string {
  return fileURLToPath(new URL(relative, metaUrl));
}

export function displayPath(p: string): string {
  const home = homedir();
  const resolved = path.resolve(p);
  return resolved === home ? "~" : resolved.startsWith(home + path.sep) ? `~/${resolved.slice(home.length + 1)}` : resolved;
}
