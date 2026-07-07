import { spawn } from "node:child_process";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export async function run(command: string, args: string[], options: RunOptions = {}): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    };

    if (options.timeoutMs && options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        stderr += `\n[pi-tavern] command timed out after ${options.timeoutMs}ms`;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 1000).unref();
      }, options.timeoutMs);
      timeout.unref();
    }

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      stderr += error.message;
      finish(127);
    });
    child.on("close", (code) => finish(code ?? 1));
  });
}

export async function git(repo: string, args: string[], options: Omit<RunOptions, "cwd"> = {}): Promise<CommandResult> {
  return await run("git", ["-C", repo, ...args], options);
}

export async function requireGit(repo: string, args: string[], options: Omit<RunOptions, "cwd"> = {}): Promise<string> {
  const result = await git(repo, args, options);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout;
}

export async function gitHead(repo: string, short = false): Promise<string | undefined> {
  const result = await git(repo, ["rev-parse", short ? "--short" : "HEAD"]);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

export async function gitCurrentBranch(repo: string): Promise<string> {
  const branch = await git(repo, ["branch", "--show-current"]);
  if (branch.code === 0 && branch.stdout.trim()) return branch.stdout.trim();
  const head = await gitHead(repo, true);
  return head ? `detached:${head}` : "unknown";
}

export async function gitStatusPorcelain(repo: string): Promise<string> {
  const result = await git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (result.code !== 0) return "";
  return result.stdout;
}

export async function gitHasStagedChanges(repo: string): Promise<boolean> {
  const result = await git(repo, ["diff", "--cached", "--quiet", "--exit-code"]);
  return result.code === 1;
}

export async function gitHasWorkingChanges(repo: string): Promise<boolean> {
  const result = await git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]);
  return result.code === 0 && result.stdout.trim().length > 0;
}
