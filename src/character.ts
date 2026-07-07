import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { exists } from "./paths.ts";
import type { CharacterCard } from "./types.ts";

function stripInlineComment(value: string): string {
  let quote: string | undefined;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if ((ch === '"' || ch === "'") && value[i - 1] !== "\\") {
      quote = quote === ch ? undefined : quote ?? ch;
    }
    if (ch === "#" && !quote && (i === 0 || /\s/.test(value[i - 1] ?? ""))) {
      return value.slice(0, i).trimEnd();
    }
  }
  return value.trimEnd();
}

function parseScalar(raw: string): unknown {
  const value = stripInlineComment(raw).trim();
  if (value === "") return "";
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((part) => String(parseScalar(part.trim())));
  }
  return value;
}

function countIndent(line: string): number {
  const match = line.match(/^\s*/);
  return match ? match[0].length : 0;
}

function parseYamlLike(text: string): Record<string, unknown> {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const out: Record<string, unknown> = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (/^\s/.test(line)) continue;

    const match = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!match) continue;

    const key = match[1];
    const rest = match[2] ?? "";
    const trimmed = stripInlineComment(rest).trim();

    if (trimmed === "|" || trimmed === ">") {
      const block: string[] = [];
      const baseIndent = (() => {
        for (let j = i + 1; j < lines.length; j++) {
          if (!lines[j].trim()) continue;
          return countIndent(lines[j]);
        }
        return 2;
      })();
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        if (next.trim() && countIndent(next) < baseIndent) break;
        i++;
        block.push(next.slice(Math.min(baseIndent, countIndent(next))));
      }
      out[key] = trimmed === ">" ? block.join(" ").replace(/\s+/g, " ").trim() : block.join("\n").replace(/\n+$/g, "");
      continue;
    }

    if (trimmed === "") {
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j];
        if (!next.trim()) {
          j++;
          continue;
        }
        const item = next.match(/^\s*-\s*(.*)$/);
        if (!item) break;
        items.push(String(parseScalar(item[1])));
        j++;
      }
      if (items.length > 0) {
        out[key] = items;
        i = j - 1;
      } else {
        out[key] = "";
      }
      continue;
    }

    out[key] = parseScalar(trimmed);
  }

  return out;
}

function normalizeCard(raw: Record<string, unknown>, fallbackName: string): CharacterCard {
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : fallbackName;
  const tags = Array.isArray(raw.tags) ? raw.tags.map(String) : typeof raw.tags === "string" ? [raw.tags] : undefined;
  return {
    ...raw,
    name,
    version: raw.version as number | string | undefined,
    description: typeof raw.description === "string" ? raw.description : undefined,
    personality: typeof raw.personality === "string" ? raw.personality : undefined,
    scenario: typeof raw.scenario === "string" ? raw.scenario : undefined,
    first_message: typeof raw.first_message === "string" ? raw.first_message : undefined,
    tags,
  };
}

export async function loadCharacter(charactersDir: string, nameOrPath: string): Promise<CharacterCard> {
  const candidates: string[] = [];
  const direct = path.resolve(nameOrPath);
  if (exists(direct)) candidates.push(direct);
  if (!path.isAbsolute(nameOrPath)) {
    candidates.push(path.join(charactersDir, nameOrPath));
    if (!/\.(ya?ml|json)$/i.test(nameOrPath)) {
      candidates.push(path.join(charactersDir, `${nameOrPath}.yaml`));
      candidates.push(path.join(charactersDir, `${nameOrPath}.yml`));
      candidates.push(path.join(charactersDir, `${nameOrPath}.json`));
    }
  }

  const file = candidates.find(exists);
  if (!file) {
    throw new Error(`Character not found: ${nameOrPath}\nLooked in ${charactersDir}`);
  }

  const text = await readFile(file, "utf8");
  const fallback = path.basename(file).replace(/\.(ya?ml|json)$/i, "");
  if (/\.json$/i.test(file)) {
    return normalizeCard(JSON.parse(text) as Record<string, unknown>, fallback);
  }
  return normalizeCard(parseYamlLike(text), fallback);
}

export async function listCharacters(charactersDir: string): Promise<string[]> {
  if (!exists(charactersDir)) return [];
  const entries = await readdir(charactersDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.(ya?ml|json)$/i.test(entry.name))
    .map((entry) => entry.name.replace(/\.(ya?ml|json)$/i, ""))
    .sort((a, b) => a.localeCompare(b));
}

export async function writeExampleCharacter(charactersDir: string): Promise<string> {
  const file = path.join(charactersDir, "alice.yaml");
  if (exists(file)) return file;
  await writeFile(
    file,
    `name: Alice\nversion: 1\ndescription: |\n  Alice is a curious archivist who speaks precisely and warmly.\npersonality: |\n  Patient, observant, dry humor.\nscenario: |\n  The user arrives at an old library during a thunderstorm.\nfirst_message: |\n  The bell above the library door trembles as you step inside. Rain ticks against the tall windows while Alice looks up from a stack of catalog cards and smiles.\ntags:\n  - fantasy\n  - librarian\n`,
    "utf8",
  );
  return file;
}
