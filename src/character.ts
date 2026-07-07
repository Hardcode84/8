import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exists } from "./paths.ts";
import type { CharacterCard } from "./types.ts";

const bundledCharactersDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "characters");

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.map(String).filter((item) => item.trim());
  if (typeof value === "string" && value.trim()) return [value];
  return undefined;
}

function isCharacterCardV2(raw: Record<string, unknown>): boolean {
  return raw.spec === "chara_card_v2" && !!asRecord(raw.data);
}

function normalizeV2Card(raw: Record<string, unknown>, fallbackName: string): CharacterCard {
  if (!isCharacterCardV2(raw)) {
    throw new Error('Unsupported character card. pi-tavern currently supports only Character Card V2 JSON with spec: "chara_card_v2".');
  }

  const data = asRecord(raw.data) ?? {};
  const name = asString(data.name) ?? fallbackName;
  const version = asString(data.character_version) ?? asString(raw.spec_version) ?? (data.version as number | string | undefined);
  return {
    source_format: "character_card_v2",
    spec: raw.spec,
    spec_version: raw.spec_version,
    data,
    name,
    version,
    description: asString(data.description),
    personality: asString(data.personality),
    scenario: asString(data.scenario),
    first_message: asString(data.first_mes) ?? asString(data.first_message),
    example_dialogue: asString(data.mes_example) ?? asString(data.example_dialogue),
    creator_notes: asString(data.creator_notes),
    system_prompt: asString(data.system_prompt),
    post_history_instructions: asString(data.post_history_instructions),
    alternate_greetings: asStringArray(data.alternate_greetings),
    tags: asStringArray(data.tags),
  };
}

function candidateFiles(charactersDir: string, nameOrPath: string): string[] {
  const candidates: string[] = [];
  const direct = path.resolve(nameOrPath);
  if (exists(direct)) candidates.push(direct);

  if (!path.isAbsolute(nameOrPath)) {
    for (const dir of [charactersDir, bundledCharactersDir]) {
      candidates.push(path.join(dir, nameOrPath));
      if (!/\.json$/i.test(nameOrPath)) candidates.push(path.join(dir, `${nameOrPath}.json`));
    }
  }

  return candidates;
}

export function resolveCharacterFile(charactersDir: string, nameOrPath: string): string {
  const file = candidateFiles(charactersDir, nameOrPath).find(exists);
  if (!file) {
    throw new Error(`Character not found: ${nameOrPath}\nLooked in ${charactersDir} and ${bundledCharactersDir}`);
  }
  if (!/\.json$/i.test(file)) {
    throw new Error(`Unsupported character file: ${file}\npi-tavern currently supports only Character Card V2 JSON files.`);
  }
  return file;
}

export async function loadCharacterFile(file: string): Promise<CharacterCard> {
  const text = await readFile(file, "utf8");
  const fallback = path.basename(file).replace(/\.json$/i, "");
  return normalizeV2Card(JSON.parse(text) as Record<string, unknown>, fallback);
}

export async function loadCharacter(charactersDir: string, nameOrPath: string): Promise<CharacterCard> {
  return await loadCharacterFile(resolveCharacterFile(charactersDir, nameOrPath));
}

async function listJsonCards(dir: string): Promise<string[]> {
  if (!exists(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && /\.json$/i.test(entry.name)).map((entry) => entry.name.replace(/\.json$/i, ""));
}

export async function listCharacters(charactersDir: string): Promise<string[]> {
  const names = [...(await listJsonCards(charactersDir)), ...(await listJsonCards(bundledCharactersDir))];
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}
