import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ALLOWED_TOOLS, HARNESS_VERSION, type SaveMeta, type TurnMeta } from "./types.ts";

const STATUS_KEY = "pi-tavern";
const TOOL_STATUS_KEY = "pi-tavern-tool";
const REGENERATE_CUSTOM_TYPE = "pi-tavern-regenerate";
const DEFAULT_MAX_WRITE_BYTES = 256 * 1024;
const MAX_READ_LIMIT = 2000;
const MAX_LIST_LIMIT = 2000;
const MAX_GREP_LIMIT = 500;
const MAX_FIND_LIMIT = 2000;

const ALLOWED_SAVE_PATHS = ["pi-session", "world", "character.json", "manifest.json", "meta.json", ".gitignore"];

let internalSessionSwitch = false;
let committing = false;
let pendingUserCommit = false;
let pendingRegenerateControlEntryId: string | undefined;

function envPath(name: string, fallback: string): string {
  return path.resolve(process.env[name] || fallback);
}

function paths(ctx?: any) {
  const world = envPath("PI_TAVERN_WORLD_DIR", ctx?.cwd ?? process.cwd());
  const save = envPath("PI_TAVERN_SAVE_ROOT", path.dirname(world));
  return {
    appRoot: envPath("PI_TAVERN_APP_ROOT", path.dirname(path.dirname(save))),
    save,
    world,
    piSession: path.join(save, "pi-session"),
    manifest: process.env.PI_TAVERN_MANIFEST_PATH || path.join(save, "manifest.json"),
    meta: process.env.PI_TAVERN_META_PATH || path.join(save, "meta.json"),
    saveId: process.env.PI_TAVERN_SAVE_ID || path.basename(save),
    character: process.env.PI_TAVERN_CHARACTER || "unknown",
  };
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function truncateOneLine(text: string, max = 72): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (block && typeof block === "object" && (block as any).type === "text") return String((block as any).text ?? "");
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function summarizeFromBranch(ctx: any, role: "user" | "assistant" | "control"): string {
  const branch = typeof ctx.sessionManager?.getBranch === "function" ? ctx.sessionManager.getBranch() : [];
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry?.type === "message" && entry.message?.role === role) {
      return truncateOneLine(contentToText(entry.message.content), 80) || role;
    }
    if (role === "control" && (entry?.type === "custom_message" || entry?.type === "custom")) {
      return truncateOneLine(String(entry.content ?? entry.data?.summary ?? "control"), 80) || "control";
    }
  }
  return role;
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function git(pi: any, repo: string, args: string[], timeout = 15000): Promise<{ code: number; stdout: string; stderr: string }> {
  return await pi.exec("git", ["-C", repo, ...args], { timeout });
}

async function gitRequired(pi: any, repo: string, args: string[], timeout = 15000): Promise<string> {
  const result = await git(pi, repo, args, timeout);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout;
}

async function currentBranch(pi: any, repo: string): Promise<string> {
  const branch = await git(pi, repo, ["branch", "--show-current"]);
  if (branch.code === 0 && branch.stdout.trim()) return branch.stdout.trim();
  const head = await git(pi, repo, ["rev-parse", "--short", "HEAD"]);
  return head.code === 0 ? `detached:${head.stdout.trim()}` : "unknown";
}

async function headShort(pi: any, repo: string): Promise<string> {
  const head = await git(pi, repo, ["rev-parse", "--short", "HEAD"]);
  return head.code === 0 ? head.stdout.trim() : "unknown";
}

async function commitPiLeaf(pi: any, repo: string, commit: string): Promise<string | undefined> {
  const result = await git(pi, repo, ["show", "-s", "--format=%B", commit]);
  if (result.code !== 0) return undefined;
  return result.stdout.match(/^pi-leaf:\s*(\S+)/m)?.[1];
}

function parseStatusPaths(status: string): string[] {
  const paths: string[] = [];
  for (const line of status.split("\n")) {
    if (!line.trim()) continue;
    const raw = line.slice(3).trim();
    if (!raw) continue;
    if (raw.includes(" -> ")) {
      const [from, to] = raw.split(" -> ");
      if (from) paths.push(from.replace(/^"|"$/g, ""));
      if (to) paths.push(to.replace(/^"|"$/g, ""));
    } else {
      paths.push(raw.replace(/^"|"$/g, ""));
    }
  }
  return paths;
}

function isAllowedSavePath(relativePath: string): boolean {
  const normalized = relativePath.split(path.sep).join("/").replace(/^\.\//, "");
  return ALLOWED_SAVE_PATHS.some((allowed) => normalized === allowed || normalized.startsWith(`${allowed}/`));
}

async function disallowedDirtyPaths(pi: any, repo: string): Promise<string[]> {
  const status = await git(pi, repo, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.code !== 0) return [];
  return parseStatusPaths(status.stdout).filter((p) => !isAllowedSavePath(p));
}

async function ensureReadyForUserInput(pi: any, ctx: any): Promise<{ ok: boolean; reason?: string }> {
  const p = paths(ctx);
  const disallowed = await disallowedDirtyPaths(pi, p.save);
  if (disallowed.length > 0) {
    return { ok: false, reason: `Refusing to continue with dirty harness-owned paths: ${disallowed.join(", ")}` };
  }
  const branch = await git(pi, p.save, ["branch", "--show-current"]);
  if (branch.code === 0 && !branch.stdout.trim()) {
    return { ok: false, reason: "You are browsing a detached git commit. Create/switch to a branch with /rp-branch before continuing." };
  }
  return { ok: true };
}

function defaultMeta(p: ReturnType<typeof paths>): SaveMeta {
  const now = new Date().toISOString();
  return {
    id: p.saveId,
    character: p.character,
    createdAt: now,
    updatedAt: now,
    currentBranch: "main",
    turns: [],
  };
}

function getRegenerateControlLeaf(ctx: any): any | undefined {
  const leaf = typeof ctx.sessionManager?.getLeafEntry === "function" ? ctx.sessionManager.getLeafEntry() : undefined;
  return leaf?.type === "custom_message" && leaf.customType === REGENERATE_CUSTOM_TYPE ? leaf : undefined;
}

function rememberRegenerateControlLeaf(ctx: any): void {
  const leaf = getRegenerateControlLeaf(ctx);
  if (leaf?.id) pendingRegenerateControlEntryId = leaf.id;
}

function removePendingRegenerateControlEntry(ctx: any): void {
  const id = pendingRegenerateControlEntryId;
  if (!id) return;
  pendingRegenerateControlEntryId = undefined;

  const sm = ctx.sessionManager;
  const fileEntries = Array.isArray(sm?.fileEntries) ? sm.fileEntries : undefined;
  if (!fileEntries) return;

  const control = fileEntries.find((entry: any) => entry?.id === id);
  if (!control) return;
  const parentId = control.parentId ?? null;

  for (const entry of fileEntries) {
    if (entry?.parentId === id) entry.parentId = parentId;
  }
  sm.fileEntries = fileEntries.filter((entry: any) => entry?.id !== id);
  sm.byId?.delete?.(id);
  if (sm.leafId === id) sm.leafId = parentId;
  sm._rewriteFile?.();
}

function sessionSnapshotThroughLeaf(ctx: any, leafId: string | undefined): unknown[] | undefined {
  if (!leafId) return undefined;
  const entries = Array.isArray(ctx.sessionManager?.fileEntries) ? ctx.sessionManager.fileEntries : undefined;
  if (!entries) return undefined;
  const byId = new Map(entries.filter((entry: any) => entry?.id).map((entry: any) => [entry.id, entry]));
  const pathIds = new Set<string>();
  let current = byId.get(leafId);
  while (current) {
    pathIds.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  if (!pathIds.has(leafId)) return undefined;

  const header = entries.find((entry: any) => entry?.type === "session");
  const pathEntries = entries.filter((entry: any) => entry?.type !== "session" && entry?.id && pathIds.has(entry.id));
  return header ? [header, ...pathEntries] : pathEntries;
}

async function writeSessionSnapshotIfMissing(sessionFile: string | undefined, entries: unknown[] | undefined): Promise<void> {
  if (!sessionFile || existsSync(sessionFile) || !entries?.length) return;
  await mkdir(path.dirname(sessionFile), { recursive: true });
  await writeFile(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

async function commitTurn(pi: any, ctx: any, role: "user" | "assistant" | "control"): Promise<void> {
  if (committing) return;
  committing = true;
  const p = paths(ctx);
  try {
    const branch = await currentBranch(pi, p.save);
    const piLeaf = typeof ctx.sessionManager?.getLeafId === "function" ? ctx.sessionManager.getLeafId() : undefined;
    const summary = summarizeFromBranch(ctx, role);
    const now = new Date().toISOString();
    const meta = await readJson<SaveMeta>(p.meta, defaultMeta(p));
    meta.id = meta.id || p.saveId;
    meta.character = meta.character || p.character;
    meta.currentBranch = branch;
    meta.updatedAt = now;
    meta.turns = Array.isArray(meta.turns) ? meta.turns : [];
    const last = meta.turns[meta.turns.length - 1];
    if (!last || last.role !== role || last.piLeaf !== piLeaf) {
      const turn: TurnMeta = { role, piLeaf, summary, createdAt: now };
      meta.turns.push(turn);
    }
    await writeJson(p.meta, meta);

    if (existsSync(p.manifest)) {
      const manifest = await readJson<Record<string, unknown>>(p.manifest, {});
      manifest.harnessVersion = String(manifest.harnessVersion || HARNESS_VERSION);
      manifest.updatedAt = now;
      await writeJson(p.manifest, manifest);
    }

    // Pi may delay writing a brand-new session file until the first assistant message.
    // Force a flush so user commits can be restored/regenerated directly. Mark it
    // flushed too; Pi's own first-assistant flush uses exclusive create when this
    // flag is false and would otherwise fail because we just created the file.
    if (typeof ctx.sessionManager?._rewriteFile === "function" && ctx.sessionManager?.sessionFile) {
      ctx.sessionManager._rewriteFile();
      ctx.sessionManager.flushed = true;
    }

    const disallowed = await disallowedDirtyPaths(pi, p.save);
    if (disallowed.length > 0) {
      ctx.ui?.notify?.(`pi-tavern blocked commit: dirty disallowed paths ${disallowed.join(", ")}`, "error");
      return;
    }

    await gitRequired(pi, p.save, ["add", "--", "pi-session", "world", "character.json", "manifest.json", "meta.json", ".gitignore"]);
    const hasChanges = await git(pi, p.save, ["diff", "--cached", "--quiet", "--exit-code"]);
    if (hasChanges.code === 0) return;

    await git(pi, p.save, ["config", "user.name", "pi-tavern"]);
    await git(pi, p.save, ["config", "user.email", "pi-tavern@example.invalid"]);
    const subject = `${role}: ${summary || piLeaf || "turn"}`;
    const message = `${subject}\n\npi-leaf: ${piLeaf ?? "unknown"}\npi-tavern-role: ${role}\ncharacter: ${p.character}`;
    const commit = await git(pi, p.save, ["commit", "-m", message], 30000);
    if (commit.code !== 0) {
      ctx.ui?.notify?.(`pi-tavern git commit failed: ${commit.stderr.trim() || commit.stdout.trim()}`, "error");
      return;
    }
    const head = await headShort(pi, p.save);
    ctx.ui?.setStatus?.(STATUS_KEY, `rp ${p.saveId} ${branch}@${head}`);
  } catch (error) {
    ctx.ui?.notify?.(`pi-tavern commit error: ${error instanceof Error ? error.message : String(error)}`, "error");
  } finally {
    committing = false;
  }
}

function cleanToolPath(raw: string): string {
  let value = raw.trim();
  if (value.startsWith("@")) value = value.slice(1);
  return value;
}

async function assertNoSymlinkComponents(base: string, target: string): Promise<void> {
  const relative = path.relative(base, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return;
  const parts = relative.split(path.sep).filter(Boolean);
  let current = base;
  for (const part of parts) {
    current = path.join(current, part);
    if (!existsSync(current)) break;
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(`symlink path components are not allowed: ${part}`);
  }
}

async function nearestExistingAncestor(target: string): Promise<string> {
  let current = target;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

async function validateWorldPath(ctx: any, rawPath: unknown, mode: "read" | "write" | "list" = "read"): Promise<string> {
  if (typeof rawPath !== "string" || !rawPath.trim()) throw new Error("path must be a non-empty string");
  const p = paths(ctx);
  const worldInfo = await lstat(p.world);
  if (worldInfo.isSymbolicLink()) throw new Error("world directory must not be a symlink");
  const saveReal = await realpath(p.save);
  const worldReal = await realpath(p.world);
  if (!isInside(saveReal, worldReal)) throw new Error("world directory real path escapes the save root");
  const cleaned = cleanToolPath(rawPath);
  if (cleaned.includes("\0")) throw new Error("NUL bytes are not allowed in paths");
  if (cleaned === "~" || cleaned.startsWith("~/")) throw new Error("home directory paths are outside the roleplay world");
  const segments = cleaned.split(/[\\/]+/).filter(Boolean);
  if (segments.includes("..")) throw new Error(".. path segments are not allowed");
  if (segments.includes(".git")) throw new Error(".git paths are not allowed");

  const resolved = path.isAbsolute(cleaned) ? path.resolve(cleaned) : path.resolve(p.world, cleaned);
  if (!isInside(p.world, resolved)) throw new Error(`path escapes the world directory: ${rawPath}`);
  await assertNoSymlinkComponents(p.world, resolved);

  const existing = existsSync(resolved) ? resolved : await nearestExistingAncestor(mode === "write" ? path.dirname(resolved) : resolved);
  const existingReal = await realpath(existing);
  if (!isInside(worldReal, existingReal)) throw new Error(`real path escapes the world directory: ${rawPath}`);
  return path.relative(p.world, resolved).split(path.sep).join("/") || ".";
}

function clampNumber(value: unknown, max: number): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.min(Math.floor(n), max);
}

async function validateToolCall(event: any, ctx: any): Promise<string[]> {
  const tool = String(event.toolName || "");
  const input = event.input || {};
  const touched: string[] = [];
  const maxWriteBytes = Number(process.env.PI_TAVERN_MAX_WRITE_BYTES || DEFAULT_MAX_WRITE_BYTES) || DEFAULT_MAX_WRITE_BYTES;

  if (!ALLOWED_TOOLS.includes(tool as any)) {
    throw new Error(`tool ${tool} is not allowed in pi-tavern`);
  }

  if (tool === "read") {
    touched.push(await validateWorldPath(ctx, input.path, "read"));
    input.limit = clampNumber(input.limit, MAX_READ_LIMIT);
    if (input.offset !== undefined) input.offset = Math.max(1, Number(input.offset) || 1);
  } else if (tool === "write") {
    touched.push(await validateWorldPath(ctx, input.path, "write"));
    if (typeof input.content !== "string") throw new Error("write.content must be a string");
    if (byteLength(input.content) > maxWriteBytes) throw new Error(`write is too large (${byteLength(input.content)} bytes > ${maxWriteBytes})`);
  } else if (tool === "edit") {
    touched.push(await validateWorldPath(ctx, input.path, "write"));
    if (!Array.isArray(input.edits)) throw new Error("edit.edits must be an array");
    const total = input.edits.reduce((sum: number, edit: any) => sum + byteLength(String(edit?.newText ?? "")), 0);
    if (total > maxWriteBytes) throw new Error(`edit replacement text is too large (${total} bytes > ${maxWriteBytes})`);
  } else if (tool === "ls") {
    if (input.path !== undefined) touched.push(await validateWorldPath(ctx, input.path || ".", "list"));
    input.limit = clampNumber(input.limit, MAX_LIST_LIMIT);
  } else if (tool === "grep") {
    if (input.path !== undefined) touched.push(await validateWorldPath(ctx, input.path || ".", "read"));
    input.limit = clampNumber(input.limit, MAX_GREP_LIMIT);
    input.context = clampNumber(input.context, 20);
  } else if (tool === "find") {
    if (input.path !== undefined) touched.push(await validateWorldPath(ctx, input.path || ".", "list"));
    input.limit = clampNumber(input.limit, MAX_FIND_LIMIT);
  }

  return touched;
}

async function showText(ctx: any, title: string, text: string): Promise<void> {
  const body = text.trim() || "(empty)";
  if (ctx.hasUI && typeof ctx.ui?.editor === "function") {
    await ctx.ui.editor(title, body);
  } else if (ctx.hasUI) {
    ctx.ui.notify(body.slice(0, 4000), "info");
  } else {
    console.log(`\n# ${title}\n${body}`);
  }
}

async function ensureCleanForCheckout(pi: any, ctx: any): Promise<boolean> {
  const p = paths(ctx);
  const status = await git(pi, p.save, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.code !== 0 || !status.stdout.trim()) return true;
  await showText(ctx, "Uncommitted save changes", status.stdout);
  ctx.ui?.notify?.("Commit or discard changes before checkout/branch operations.", "warning");
  return false;
}

async function reloadCurrentSession(ctx: any, message: string, withSession?: (newCtx: any) => Promise<void>): Promise<void> {
  const sessionFile = ctx.sessionManager?.getSessionFile?.();
  if (!sessionFile) {
    ctx.ui?.notify?.("No persisted Pi session file to reload", "warning");
    return;
  }
  if (!existsSync(sessionFile)) {
    ctx.ui?.notify?.("The checked-out commit does not contain the current Pi session file. Choose a later turn or restart this save.", "warning");
    return;
  }
  internalSessionSwitch = true;
  try {
    const result = await ctx.switchSession(sessionFile, {
      withSession: async (newCtx: any) => {
        newCtx.ui?.notify?.(message, "info");
        if (withSession) await withSession(newCtx);
      },
    });
    if (result?.cancelled) ctx.ui?.notify?.("Session reload cancelled", "warning");
  } finally {
    internalSessionSwitch = false;
  }
}

async function listWorldFiles(world: string, dir = ".", out: string[] = []): Promise<string[]> {
  const abs = path.join(world, dir);
  const entries = await readdir(abs, { withFileTypes: true });
  for (const entry of entries) {
    const rel = dir === "." ? entry.name : path.join(dir, entry.name);
    if (entry.name === ".git") continue;
    const full = path.join(world, rel);
    const info = await lstat(full);
    if (info.isSymbolicLink()) continue;
    if (entry.isDirectory()) await listWorldFiles(world, rel, out);
    else out.push(rel.split(path.sep).join("/"));
  }
  return out.sort((a, b) => a.localeCompare(b));
}

async function listSavesText(appRoot: string): Promise<string> {
  const savesDir = path.join(appRoot, "saves");
  if (!existsSync(savesDir)) return "No saves found.";
  const entries = await readdir(savesDir, { withFileTypes: true });
  const lines: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const root = path.join(savesDir, entry.name);
    const meta = await readJson<Partial<SaveMeta>>(path.join(root, "meta.json"), {});
    lines.push(`${meta.id ?? entry.name}\t${meta.character ?? "?"}\t${meta.currentBranch ?? "?"}\t${meta.updatedAt ?? "?"}`);
  }
  return lines.sort().join("\n") || "No saves found.";
}

function safeBranchName(input: string): string {
  const cleaned = input
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/[^A-Za-z0-9._/-]+/g, "-")
    .replace(/\.\.+/g, ".")
    .replace(/^[-/.]+|[-/.]+$/g, "");
  return cleaned || `branch-${Date.now()}`;
}

async function checkoutTarget(pi: any, ctx: any, target: string): Promise<void> {
  const p = paths(ctx);
  if (!(await ensureCleanForCheckout(pi, ctx))) return;
  const branchCheck = await git(pi, p.save, ["show-ref", "--verify", `refs/heads/${target}`]);
  const result = branchCheck.code === 0 ? await git(pi, p.save, ["switch", target]) : await git(pi, p.save, ["checkout", target]);
  if (result.code !== 0) {
    ctx.ui?.notify?.(`Checkout failed: ${result.stderr.trim() || result.stdout.trim()}`, "error");
    return;
  }
  await reloadCurrentSession(ctx, `Checked out ${target}`);
}

async function registerCommands(pi: any): Promise<void> {
  pi.registerCommand("rp-saves", {
    description: "List pi-tavern saves in this app data root",
    handler: async (_args: string, ctx: any) => {
      const p = paths(ctx);
      await showText(ctx, "pi-tavern saves", await listSavesText(p.appRoot));
    },
  });

  pi.registerCommand("rp-load", {
    description: "Explain how to load another pi-tavern save",
    handler: async (_args: string, ctx: any) => {
      ctx.ui?.notify?.("Launch another save from your shell with: pi-tavern launch <save-id>", "info");
    },
  });

  pi.registerCommand("rp-new", {
    description: "Explain how to create a new pi-tavern save",
    handler: async (_args: string, ctx: any) => {
      ctx.ui?.notify?.("Create saves from your shell with: pi-tavern new <character>", "info");
    },
  });

  pi.registerCommand("rp-status", {
    description: "Show pi-tavern save/branch status",
    handler: async (_args: string, ctx: any) => {
      const p = paths(ctx);
      const branch = await currentBranch(pi, p.save);
      const head = await headShort(pi, p.save);
      const status = await git(pi, p.save, ["status", "--short", "--branch"]);
      await showText(ctx, "pi-tavern status", `save: ${p.saveId}\ncharacter: ${p.character}\nbranch: ${branch}\nhead: ${head}\nworld: ${p.world}\n\n${status.stdout}`);
    },
  });

  pi.registerCommand("rp-log", {
    description: "Show git-backed roleplay turn log",
    handler: async (args: string, ctx: any) => {
      const p = paths(ctx);
      const count = Number(args.trim()) || 50;
      const log = await git(pi, p.save, ["log", "--graph", "--decorate", "--oneline", "--all", `--max-count=${Math.min(count, 200)}`]);
      await showText(ctx, "pi-tavern log", log.stdout || log.stderr);
    },
  });

  pi.registerCommand("rp-branches", {
    description: "Show roleplay git branches",
    handler: async (_args: string, ctx: any) => {
      const p = paths(ctx);
      const branches = await git(pi, p.save, ["branch", "--all", "--verbose", "--no-abbrev"]);
      await showText(ctx, "pi-tavern branches", branches.stdout || branches.stderr);
    },
  });

  pi.registerCommand("rp-checkout", {
    description: "Checkout a roleplay branch or commit and reload the Pi session",
    handler: async (args: string, ctx: any) => {
      await ctx.waitForIdle?.();
      const p = paths(ctx);
      const targetArg = args.trim();
      if (targetArg) {
        await checkoutTarget(pi, ctx, targetArg);
        return;
      }
      const choices = new Map<string, string>();
      const branchResult = await git(pi, p.save, ["for-each-ref", "--format=%(refname:short)%09%(objectname:short)%09%(subject)", "refs/heads"]);
      for (const line of branchResult.stdout.split("\n").filter(Boolean)) {
        const [name, hash, subject] = line.split("\t");
        const label = `branch  ${name}  ${hash}  ${subject ?? ""}`;
        choices.set(label, name);
      }
      const log = await git(pi, p.save, ["log", "--format=%h%x09%s", "--max-count=50", "--all"]);
      for (const line of log.stdout.split("\n").filter(Boolean)) {
        const [hash, subject] = line.split("\t");
        const label = `commit  ${hash}  ${subject ?? ""}`;
        choices.set(label, hash);
      }
      if (choices.size === 0) {
        ctx.ui?.notify?.("No branches or commits found", "warning");
        return;
      }
      const selected = await ctx.ui.select("Checkout branch or commit", [...choices.keys()]);
      if (!selected) return;
      await checkoutTarget(pi, ctx, choices.get(selected)!);
    },
  });

  pi.registerCommand("rp-branch", {
    description: "Create/switch to a roleplay branch: /rp-branch <name> [commit]",
    handler: async (args: string, ctx: any) => {
      await ctx.waitForIdle?.();
      if (!(await ensureCleanForCheckout(pi, ctx))) return;
      const p = paths(ctx);
      const parts = args.trim().split(/\s+/).filter(Boolean);
      let name = parts[0];
      const target = parts[1];
      if (!name && ctx.hasUI) name = await ctx.ui.input("New branch name", "branch/name");
      if (!name) return;
      const branch = safeBranchName(name.startsWith("branch/") || name.startsWith("regen/") ? name : `branch/${name}`);
      const result = await git(pi, p.save, ["switch", "-c", branch, ...(target ? [target] : [])]);
      if (result.code !== 0) {
        ctx.ui?.notify?.(`Branch failed: ${result.stderr.trim() || result.stdout.trim()}`, "error");
        return;
      }
      await reloadCurrentSession(ctx, `Switched to ${branch}`);
    },
  });

  pi.registerCommand("rp-files", {
    description: "Browse world files",
    handler: async (_args: string, ctx: any) => {
      const p = paths(ctx);
      const files = await listWorldFiles(p.world);
      if (files.length === 0) {
        ctx.ui?.notify?.("world/ is empty", "info");
        return;
      }
      const selected = ctx.hasUI ? await ctx.ui.select("World files", files) : undefined;
      if (!selected) {
        await showText(ctx, "world files", files.join("\n"));
        return;
      }
      const full = path.join(p.world, selected);
      const info = await stat(full);
      if (info.size > 64 * 1024) {
        ctx.ui?.notify?.(`${selected} is too large to preview (${info.size} bytes)`, "warning");
        return;
      }
      await showText(ctx, selected, await readFile(full, "utf8"));
    },
  });

  pi.registerCommand("rp-diff", {
    description: "Show world diff for the latest turn or working tree",
    handler: async (args: string, ctx: any) => {
      const p = paths(ctx);
      const mode = args.trim();
      const result = mode === "working" ? await git(pi, p.save, ["diff", "--", "world"]) : await git(pi, p.save, ["show", "--stat", "--patch", "--max-count=1", "HEAD", "--", "world", "manifest.json", "meta.json"]);
      await showText(ctx, "pi-tavern diff", result.stdout || result.stderr);
    },
  });

  pi.registerCommand("rp-regenerate", {
    description: "Regenerate the last assistant turn on the current branch",
    handler: async (_args: string, ctx: any) => {
      await ctx.waitForIdle?.();
      if (!(await ensureCleanForCheckout(pi, ctx))) return;
      const p = paths(ctx);
      const branchResult = await git(pi, p.save, ["branch", "--show-current"]);
      const branch = branchResult.stdout.trim();
      if (!branch) {
        ctx.ui?.notify?.("Cannot regenerate while browsing a detached commit. Switch to a branch first.", "warning");
        return;
      }
      const log = await git(pi, p.save, ["log", "--format=%H%x09%s", "--max-count=100"]);
      const targetLine = log.stdout
        .split("\n")
        .filter(Boolean)
        .find((line) => /^user[: ]/i.test(line.split("\t")[1] ?? ""));
      if (!targetLine) {
        ctx.ui?.notify?.("No previous user turn commit found", "warning");
        return;
      }
      const target = targetLine.split("\t")[0];
      const targetLeaf = await commitPiLeaf(pi, p.save, target);
      const sessionFile = ctx.sessionManager?.getSessionFile?.();
      const sessionSnapshot = sessionSnapshotThroughLeaf(ctx, targetLeaf);
      const result = await git(pi, p.save, ["reset", "--hard", target]);
      if (result.code !== 0) {
        ctx.ui?.notify?.(`Regenerate reset failed: ${result.stderr.trim() || result.stdout.trim()}`, "error");
        return;
      }
      await writeSessionSnapshotIfMissing(sessionFile, sessionSnapshot);
      await reloadCurrentSession(ctx, `Regenerating from ${target.slice(0, 8)} on ${branch}`, async (newCtx) => {
        if (typeof newCtx.sendMessage === "function") {
          await newCtx.sendMessage(
            {
              customType: REGENERATE_CUSTOM_TYPE,
              content: "",
              display: false,
              details: { target, transparent: true },
            },
            { triggerTurn: true },
          );
        } else {
          newCtx.ui?.notify?.("Reloaded at user turn; submit a message to continue.", "info");
        }
      });
    },
  });
}

export default function piTavernExtension(pi: any) {
  void registerCommands(pi);

  pi.on("project_trust", async (_event: any, _ctx: any) => {
    return { trusted: "no" };
  });

  pi.on("session_start", async (_event: any, ctx: any) => {
    const p = paths(ctx);
    const branch = await currentBranch(pi, p.save).catch(() => "unknown");
    const head = await headShort(pi, p.save).catch(() => "unknown");
    pi.setActiveTools?.([...ALLOWED_TOOLS]);
    pi.setSessionName?.(`pi-tavern:${p.saveId}`);
    ctx.ui?.setStatus?.(STATUS_KEY, `rp ${p.saveId} ${branch}@${head}`);
    if (path.resolve(ctx.cwd) !== path.resolve(p.world)) {
      ctx.ui?.notify?.(`pi-tavern expected cwd ${p.world}, got ${ctx.cwd}`, "warning");
    }
  });

  pi.on("input", async (event: any, ctx: any) => {
    if (event.source === "extension") return { action: "continue" };
    const ready = await ensureReadyForUserInput(pi, ctx);
    if (!ready.ok) {
      ctx.ui?.notify?.(ready.reason, "error");
      return { action: "handled" };
    }
    return { action: "continue" };
  });

  pi.on("context", async (event: any) => {
    const messages = Array.isArray(event.messages)
      ? event.messages.filter((message: any) => !(message?.role === "custom" && message.customType === REGENERATE_CUSTOM_TYPE))
      : event.messages;
    return { messages };
  });

  pi.on("agent_start", async () => {
    pendingUserCommit = true;
  });

  pi.on("before_provider_request", async (_event: any, ctx: any) => {
    if (!pendingUserCommit) return undefined;
    pendingUserCommit = false;
    if (getRegenerateControlLeaf(ctx)) {
      rememberRegenerateControlLeaf(ctx);
      return undefined;
    }
    await commitTurn(pi, ctx, "user");
    return undefined;
  });

  pi.on("agent_end", async (_event: any, ctx: any) => {
    removePendingRegenerateControlEntry(ctx);
    await commitTurn(pi, ctx, "assistant");
  });

  pi.on("tool_call", async (event: any, ctx: any) => {
    try {
      const touched = await validateToolCall(event, ctx);
      if (touched.length > 0) ctx.ui?.setStatus?.(TOOL_STATUS_KEY, `${event.toolName} ${touched.join(", ")}`);
      return undefined;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      ctx.ui?.notify?.(`Blocked ${event.toolName}: ${reason}`, "warning");
      return { block: true, reason };
    }
  });

  pi.on("tool_result", async (_event: any, ctx: any) => {
    ctx.ui?.setStatus?.(TOOL_STATUS_KEY, undefined);
  });

  pi.on("user_bash", async (event: any, ctx: any) => {
    ctx.ui?.notify?.("User shell commands are disabled in pi-tavern.", "warning");
    return {
      result: {
        output: `Blocked by pi-tavern: shell commands are disabled. Command was: ${event.command}`,
        exitCode: 126,
        cancelled: false,
        truncated: false,
      },
    };
  });

  pi.on("session_before_switch", async (event: any, ctx: any) => {
    if (internalSessionSwitch) return undefined;
    ctx.ui?.notify?.(`Built-in session ${event.reason} is disabled. Use /rp-checkout or launch another save with pi-tavern.`, "warning");
    return { cancel: true };
  });

  pi.on("session_before_fork", async (_event: any, ctx: any) => {
    ctx.ui?.notify?.("Built-in /fork and /clone are disabled. Use git-backed /rp-branch or /rp-regenerate.", "warning");
    return { cancel: true };
  });

  pi.on("session_before_tree", async (_event: any, ctx: any) => {
    ctx.ui?.notify?.("Built-in /tree is disabled in pi-tavern. Use /rp-log and /rp-checkout.", "warning");
    return { cancel: true };
  });

  pi.on("session_before_compact", async (_event: any, ctx: any) => {
    if (!ctx.hasUI) return undefined;
    const ok = await ctx.ui.confirm("Compact session?", "Compaction is lossy. Git history remains, but current context will be summarized.");
    if (!ok) return { cancel: true };
    return undefined;
  });
}
