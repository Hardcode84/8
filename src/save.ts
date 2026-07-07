import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadCharacter } from "./character.ts";
import { git, requireGit } from "./git.ts";
import { composeSystemPrompt, hashSystemPrompt } from "./prompt.ts";
import { ensureAppDirs, ensureDir, exists, getSavePaths, makeSaveId } from "./paths.ts";
import { HARNESS_VERSION, type AppPaths, type RuntimeManifest, type SaveMeta } from "./types.ts";

export interface CreateSaveOptions {
  character: string;
  saveId?: string;
  model?: string;
  provider?: string;
}

export interface SaveSummary {
  id: string;
  root: string;
  character?: string;
  updatedAt?: string;
  currentBranch?: string;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function initializeAppHome(paths: AppPaths): Promise<void> {
  await ensureAppDirs(paths);
  const settingsPath = path.join(paths.piHome, "settings.json");
  if (!exists(settingsPath)) {
    await writeJson(settingsPath, {
      defaultProjectTrust: "never",
      enableInstallTelemetry: false,
    });
  }
}

async function initGitRepo(saveRoot: string): Promise<void> {
  if (!exists(path.join(saveRoot, ".git"))) {
    let init = await git(saveRoot, ["init", "-b", "main"]);
    if (init.code !== 0) {
      init = await git(saveRoot, ["init"]);
      if (init.code !== 0) throw new Error(init.stderr.trim() || init.stdout.trim() || "git init failed");
      await git(saveRoot, ["checkout", "-B", "main"]);
    }
  }
  await git(saveRoot, ["config", "user.name", "pi-tavern"]);
  await git(saveRoot, ["config", "user.email", "pi-tavern@example.invalid"]);
}

export async function createSave(app: AppPaths, options: CreateSaveOptions): Promise<{ paths: ReturnType<typeof getSavePaths>; meta: SaveMeta }> {
  await initializeAppHome(app);
  const character = await loadCharacter(app.characters, options.character);
  const saveId = options.saveId || makeSaveId(character.name);
  const saveRoot = path.join(app.saves, saveId);
  if (exists(saveRoot)) throw new Error(`Save already exists: ${saveId}`);

  const save = getSavePaths(saveRoot);
  await ensureDir(save.piSession);
  await ensureDir(save.world);
  await ensureDir(path.join(save.world, "lore"));
  await ensureDir(path.join(save.world, "notes"));
  await ensureDir(path.join(save.world, "artifacts"));

  const now = new Date().toISOString();
  const prompt = composeSystemPrompt(character, { saveId, worldDir: save.world });
  const manifest: RuntimeManifest = {
    model: options.model,
    provider: options.provider,
    character: character.name,
    systemPromptHash: hashSystemPrompt(prompt),
    harnessVersion: HARNESS_VERSION,
    createdAt: now,
    updatedAt: now,
  };
  const meta: SaveMeta = {
    id: saveId,
    character: options.character,
    createdAt: now,
    updatedAt: now,
    currentBranch: "main",
    turns: [],
  };

  await writeFile(
    path.join(save.world, "memory.md"),
    `# Session Memory\n\nThis file is persistent, editable memory for the roleplay session. Keep it concise and useful.\n\n## Character\n${character.name}\n\n${
      character.scenario ? `## Scenario\n${character.scenario.trim()}\n\n` : ""
    }${character.first_message ? `## Opening\n${character.first_message.trim()}\n` : ""}`,
    "utf8",
  );
  await writeFile(path.join(save.world, "lore", ".gitkeep"), "", "utf8");
  await writeFile(path.join(save.world, "notes", ".gitkeep"), "", "utf8");
  await writeFile(path.join(save.world, "artifacts", ".gitkeep"), "", "utf8");
  await writeFile(
    path.join(save.root, ".gitignore"),
    `# pi-tavern save repository\n.DS_Store\n*.tmp\n`,
    "utf8",
  );
  await writeJson(save.manifest, manifest);
  await writeJson(save.meta, meta);

  await initGitRepo(save.root);
  await requireGit(save.root, ["add", ".gitignore", "manifest.json", "meta.json", "world", "pi-session"]);
  await requireGit(save.root, ["commit", "-m", "turn 0: initialize pi-tavern save"]);

  return { paths: save, meta };
}

export async function readSaveMeta(saveRoot: string): Promise<SaveMeta | undefined> {
  const metaPath = getSavePaths(saveRoot).meta;
  if (!exists(metaPath)) return undefined;
  return JSON.parse(await readFile(metaPath, "utf8")) as SaveMeta;
}

export async function listSaves(app: AppPaths): Promise<SaveSummary[]> {
  await ensureDir(app.saves);
  const entries = await readdir(app.saves, { withFileTypes: true });
  const saves: SaveSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const root = path.join(app.saves, entry.name);
    const meta = await readSaveMeta(root).catch(() => undefined);
    saves.push({
      id: meta?.id ?? entry.name,
      root,
      character: meta?.character,
      updatedAt: meta?.updatedAt,
      currentBranch: meta?.currentBranch,
    });
  }
  return saves.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

export function resolveSaveRoot(app: AppPaths, saveIdOrPath: string): string {
  const direct = path.resolve(saveIdOrPath);
  if (exists(direct)) return direct;
  return path.join(app.saves, saveIdOrPath);
}

export async function updateManifestForLaunch(
  saveRoot: string,
  patch: Partial<Pick<RuntimeManifest, "model" | "provider" | "systemPromptHash">>,
): Promise<void> {
  const save = getSavePaths(saveRoot);
  const current = exists(save.manifest)
    ? (JSON.parse(await readFile(save.manifest, "utf8")) as RuntimeManifest)
    : ({} as RuntimeManifest);
  const filteredPatch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
  const candidate: RuntimeManifest = {
    ...current,
    character: current.character ?? "unknown",
    harnessVersion: HARNESS_VERSION,
    createdAt: current.createdAt ?? new Date().toISOString(),
    ...filteredPatch,
  };
  const changed = (["character", "harnessVersion", "createdAt", "model", "provider", "systemPromptHash"] as const).some(
    (key) => candidate[key] !== current[key],
  );
  if (!changed) return;
  await writeJson(save.manifest, {
    ...candidate,
    updatedAt: new Date().toISOString(),
  });
}
