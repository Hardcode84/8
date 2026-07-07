import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { listCharacters, loadCharacter, writeExampleCharacter } from "./character.ts";
import { composeSystemPrompt, hashSystemPrompt } from "./prompt.ts";
import { createSave, initializeAppHome, listSaves, readSaveMeta, resolveSaveRoot, updateManifestForLaunch } from "./save.ts";
import { displayPath, exists, fromHere, getAppPaths, getSavePaths } from "./paths.ts";
import { ALLOWED_TOOLS } from "./types.ts";

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const name = arg.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      flags[name] = next;
      i++;
    } else {
      flags[name] = true;
    }
  }
  return { positional, flags };
}

function flagString(flags: Record<string, string | boolean>, name: string, fallback?: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : fallback;
}

function usage(): string {
  return `pi-tavern 0.1.0

Usage:
  pi-tavern new <character> [--save-id <id>] [--model <model>] [--provider <provider>] [--no-launch]
  pi-tavern launch [save-id] [--model <model>] [--provider <provider>]
  pi-tavern saves
  pi-tavern characters
  pi-tavern init-example-character
  pi-tavern compose-system-prompt <character>
  pi-tavern paths

Global flags:
  --app-data <dir>       Override app data root (default: $PI_TAVERN_HOME or ~/.local/share/pi-tavern)
  --pi-bin <path>        Pi executable (default: pi)

Environment:
  PI_TAVERN_HOME         App data root
  PI_TAVERN_MODEL        Default model passed to pi
  PI_TAVERN_PROVIDER     Default provider passed to pi
`;
}

async function chooseSave(appRoot: ReturnType<typeof getAppPaths>): Promise<string | undefined> {
  const saves = await listSaves(appRoot);
  if (saves.length === 0) return undefined;
  if (!process.stdin.isTTY) return saves[0]?.id;
  const rl = createInterface({ input, output });
  try {
    console.log("Available saves:");
    saves.forEach((save, index) => {
      console.log(
        `  ${index + 1}. ${save.id}${save.character ? ` (${save.character})` : ""}${
          save.currentBranch ? ` [${save.currentBranch}]` : ""
        }`,
      );
    });
    const answer = await rl.question("Choose save number (empty for latest): ");
    if (!answer.trim()) return saves[0]?.id;
    const index = Number(answer.trim()) - 1;
    return saves[index]?.id;
  } finally {
    rl.close();
  }
}

async function launchSave(appRoot: ReturnType<typeof getAppPaths>, saveIdOrPath: string | undefined, flags: Record<string, string | boolean>): Promise<number> {
  await initializeAppHome(appRoot);
  const selected = saveIdOrPath || (await chooseSave(appRoot));
  if (!selected) throw new Error("No saves found. Create one with: pi-tavern new <character>");

  const saveRoot = resolveSaveRoot(appRoot, selected);
  if (!exists(saveRoot)) throw new Error(`Save not found: ${selected}`);
  const save = getSavePaths(saveRoot);
  const meta = await readSaveMeta(saveRoot);
  if (!meta) throw new Error(`Missing meta.json in save: ${saveRoot}`);

  const character = await loadCharacter(appRoot.characters, meta.character);
  const prompt = composeSystemPrompt(character, { saveId: meta.id, worldDir: save.world });
  const model = flagString(flags, "model", process.env.PI_TAVERN_MODEL);
  const provider = flagString(flags, "provider", process.env.PI_TAVERN_PROVIDER);
  await updateManifestForLaunch(save.root, {
    model,
    provider,
    systemPromptHash: hashSystemPrompt(prompt),
  });

  const extensionPath = fromHere(import.meta.url, "./extension.ts");
  const piBin = flagString(flags, "pi-bin", "pi") ?? "pi";
  const piArgs = [
    "--continue",
    "--session-dir",
    save.piSession,
    "--system-prompt",
    prompt,
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-extensions",
    "--no-themes",
    "--extension",
    extensionPath,
    "--tools",
    ALLOWED_TOOLS.join(","),
    "--name",
    `pi-tavern:${meta.id}`,
    "--no-approve",
  ];
  if (provider) piArgs.push("--provider", provider);
  if (model) piArgs.push("--model", model);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PI_CODING_AGENT_DIR: appRoot.piHome,
    PI_CODING_AGENT_SESSION_DIR: save.piSession,
    PI_TAVERN_APP_ROOT: appRoot.root,
    PI_TAVERN_SAVE_ROOT: save.root,
    PI_TAVERN_WORLD_DIR: save.world,
    PI_TAVERN_SAVE_ID: meta.id,
    PI_TAVERN_CHARACTER: meta.character,
    PI_TAVERN_MANIFEST_PATH: save.manifest,
    PI_TAVERN_META_PATH: save.meta,
    PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK ?? "1",
    PI_TELEMETRY: process.env.PI_TELEMETRY ?? "0",
  };

  console.log(`Launching pi-tavern save ${meta.id}`);
  console.log(`World: ${displayPath(save.world)}`);
  const child = spawn(piBin, piArgs, {
    cwd: save.world,
    env,
    stdio: "inherit",
  });

  return await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 0));
  });
}

async function printSaves(appRoot: ReturnType<typeof getAppPaths>): Promise<void> {
  const saves = await listSaves(appRoot);
  if (saves.length === 0) {
    console.log("No saves yet.");
    return;
  }
  for (const save of saves) {
    console.log(
      `${save.id}\t${save.character ?? "?"}\t${save.currentBranch ?? "?"}\t${save.updatedAt ?? "?"}\t${displayPath(save.root)}`,
    );
  }
}

async function printCharacters(appRoot: ReturnType<typeof getAppPaths>): Promise<void> {
  await initializeAppHome(appRoot);
  const characters = await listCharacters(appRoot.characters);
  if (characters.length === 0) {
    console.log(`No characters found in ${displayPath(appRoot.characters)}.`);
    console.log("Create one with: pi-tavern init-example-character");
    return;
  }
  characters.forEach((name) => console.log(name));
}

export async function main(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);
  const [command = "help", ...rest] = parsed.positional;
  const appRoot = getAppPaths(flagString(parsed.flags, "app-data"));

  try {
    switch (command) {
      case "help":
      case "--help":
      case "-h":
        console.log(usage());
        return;

      case "paths":
        await initializeAppHome(appRoot);
        console.log(`app-data\t${displayPath(appRoot.root)}`);
        console.log(`pi-home\t${displayPath(appRoot.piHome)}`);
        console.log(`characters\t${displayPath(appRoot.characters)}`);
        console.log(`saves\t${displayPath(appRoot.saves)}`);
        return;

      case "init-example-character": {
        await initializeAppHome(appRoot);
        const file = await writeExampleCharacter(appRoot.characters);
        console.log(`Wrote ${displayPath(file)}`);
        return;
      }

      case "characters":
      case "chars":
        await printCharacters(appRoot);
        return;

      case "saves":
      case "list":
        await printSaves(appRoot);
        return;

      case "compose-system-prompt": {
        const characterName = rest[0];
        if (!characterName) throw new Error("Missing character name");
        await initializeAppHome(appRoot);
        const character = await loadCharacter(appRoot.characters, characterName);
        console.log(composeSystemPrompt(character));
        return;
      }

      case "new": {
        const characterName = rest[0];
        if (!characterName) throw new Error("Missing character name");
        const created = await createSave(appRoot, {
          character: characterName,
          saveId: flagString(parsed.flags, "save-id"),
          model: flagString(parsed.flags, "model", process.env.PI_TAVERN_MODEL),
          provider: flagString(parsed.flags, "provider", process.env.PI_TAVERN_PROVIDER),
        });
        console.log(`Created save ${created.meta.id}`);
        console.log(`Root: ${displayPath(created.paths.root)}`);
        if (parsed.flags["no-launch"]) return;
        const code = await launchSave(appRoot, created.meta.id, parsed.flags);
        process.exitCode = code;
        return;
      }

      case "launch":
      case "load":
      case "run": {
        const code = await launchSave(appRoot, rest[0], parsed.flags);
        process.exitCode = code;
        return;
      }

      case "show-meta": {
        const saveId = rest[0] || (await chooseSave(appRoot));
        if (!saveId) throw new Error("No save selected");
        const saveRoot = resolveSaveRoot(appRoot, saveId);
        const metaPath = getSavePaths(saveRoot).meta;
        console.log(await readFile(metaPath, "utf8"));
        return;
      }

      default:
        throw new Error(`Unknown command: ${command}\n\n${usage()}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
