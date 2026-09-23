/**
 * Resolve the `claude` CLI binary (from OpenChamber harness executable-path).
 *
 * Every probe is an async spawn with a hard timeout: detection runs inside the
 * long-lived host process (plugin load, sign-in polling, every Agent SDK
 * query), and a synchronous spawn there stalls the event loop that also
 * serves the proxy's streams and the host's health checks.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildClaudeCodeChildEnv } from "./auth-env.js";

type ProbeEnv = NodeJS.ProcessEnv | Record<string, string | undefined>;

export type CliProbeResult = {
  /** Exit code; null when the process could not start, timed out, or was signalled. */
  status: number | null;
  stdout: string;
  /** Spawn error or timeout — the probe produced no trustworthy answer. */
  failed: boolean;
};

/** Probes print a version or a small JSON document; anything larger is noise. */
const MAX_PROBE_OUTPUT = 64 * 1024;

/**
 * Run a short-lived CLI probe without blocking the event loop. The child is
 * killed and the probe reported as failed once `timeoutMs` elapses.
 */
export function runCliProbe(
  command: string,
  args: string[],
  options: { env?: ProbeEnv; timeoutMs: number },
): Promise<CliProbeResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    let child: ChildProcess | undefined;
    const finish = (status: number | null, failed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, stdout, failed });
    };
    const timer = setTimeout(() => {
      child?.kill("SIGKILL");
      finish(null, true);
    }, options.timeoutMs);

    try {
      child = spawn(command, args, {
        env: options.env as NodeJS.ProcessEnv | undefined,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      finish(null, true);
      return;
    }
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < MAX_PROBE_OUTPUT) stdout += chunk;
    });
    child.once("error", () => finish(null, true));
    child.once("close", (code: number | null) => finish(code, false));
  });
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    await access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function probeClaude(candidate: string, env: ProbeEnv): Promise<boolean> {
  const result = await runCliProbe(candidate, ["--version"], {
    env: buildClaudeCodeChildEnv(env),
    timeoutMs: 4000,
  });
  if (result.failed) return false;
  return result.status === 0 || Boolean(result.stdout.trim());
}

/** Explicit paths are checked on disk first so absent candidates never spawn. */
async function probeClaudePath(candidate: string, env: ProbeEnv): Promise<boolean> {
  return (await isExecutableFile(candidate)) && (await probeClaude(candidate, env));
}

/**
 * Install locations the managed OpenChamber server commonly misses because its
 * PATH is not a login shell's PATH: the official installer's `~/.local/bin`
 * and the npm global bin.
 */
async function knownClaudeLocations(env: ProbeEnv): Promise<string[]> {
  const home = typeof env.HOME === "string" && env.HOME ? env.HOME : homedir();
  const candidates = [join(home, ".local", "bin", "claude")];

  const prefix = await runCliProbe("npm", ["prefix", "-g"], { timeoutMs: 6000 });
  const dir = prefix.failed ? "" : prefix.stdout.trim();
  if (dir) candidates.push(join(dir, "bin", "claude"));
  return candidates;
}

export async function findBinaryOnPath(
  name: string,
  env: ProbeEnv = process.env,
): Promise<string | null> {
  const pathEnv = typeof env.PATH === "string" ? env.PATH : "";
  const parts = pathEnv.split(process.platform === "win32" ? ";" : ":");
  const exts =
    process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  for (const dir of parts) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = `${dir.replace(/[/\\]$/, "")}/${name}${ext}`;
      if (await probeClaudePath(candidate, env)) return candidate;
    }
  }

  return (await probeClaude(name, env)) ? name : null;
}

/**
 * `claude` as the managed server sees it: PATH first, then the install
 * locations that a clean server environment usually cannot see.
 *
 * Resolution is memoized per PATH+HOME: it runs on every Agent SDK query, and
 * re-probing (`npm prefix -g`, `claude --version`) would spawn several
 * processes per turn.
 */
let cachedResolution: { key: string; path: string | null } | null = null;

export async function resolveClaudeCli(
  env: ProbeEnv = process.env,
): Promise<string | null> {
  const key = `${env.PATH ?? ""}\0${env.HOME ?? ""}`;
  if (cachedResolution && cachedResolution.key === key) {
    return cachedResolution.path;
  }
  let resolved = await findBinaryOnPath("claude", env);
  if (!resolved) {
    for (const candidate of await knownClaudeLocations(env)) {
      if (await probeClaudePath(candidate, env)) {
        resolved = candidate;
        break;
      }
    }
  }
  // Only positive hits are memoized — a CLI installed mid-process (the
  // one-click install action) must be found on the next detect.
  if (resolved) cachedResolution = { key, path: resolved };
  return resolved;
}

/** Test hook: drop the memoized resolution. */
export function resetClaudeCliResolutionCache(): void {
  cachedResolution = null;
}

export function resolveClaudeCodeExecutable(options?: {
  env?: ProbeEnv;
}): Promise<string | null> {
  return resolveClaudeCli(options?.env ?? process.env);
}

export function assertClaudeWorkingDirectory(cwd: unknown): string {
  return typeof cwd === "string" && cwd.trim() ? cwd.trim() : process.cwd();
}
