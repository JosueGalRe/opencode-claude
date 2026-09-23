/**
 * Claude CLI detection + Agent SDK probe (from OpenChamber harness).
 */
import { buildClaudeCodeChildEnv } from "./auth-env.js";
import { resolveClaudeCli, runCliProbe } from "./executable-path.js";
import { probeClaudeAgentSdk } from "./query.js";

export type ClaudeDetectStatus =
  | "ready"
  | "needs-login"
  | "missing-cli"
  | "missing-sdk"
  | "error";

export type ClaudeDetectResult = {
  status: ClaudeDetectStatus;
  statusDetail?: string;
  binaryPath?: string | null;
  version?: string | null;
  sdkAvailable: boolean;
  loggedIn: boolean;
};

export function interpretClaudeAuthStatus(payload: unknown): {
  loggedIn: boolean;
  detail: string;
  authMethod?: string;
} {
  if (!payload || typeof payload !== "object") {
    return { loggedIn: false, detail: "invalid-auth-status" };
  }
  const root = payload as Record<string, unknown>;
  const loggedIn = Boolean(root.loggedIn);
  const authMethod =
    typeof root.authMethod === "string" ? root.authMethod : "none";
  const normalized = authMethod.trim().toLowerCase();

  if (!loggedIn) {
    return { loggedIn: false, detail: "auth-status-logged-out", authMethod };
  }

  if (
    normalized === "none" ||
    normalized.includes("api") ||
    normalized.includes("console")
  ) {
    return { loggedIn: false, detail: "api-key-only", authMethod };
  }

  const subscription = ["oauth", "claude", "subscription"].some((hint) =>
    normalized.includes(hint),
  );
  return {
    loggedIn: true,
    detail: subscription ? "auth-status-oauth" : "auth-status-logged-in",
    authMethod,
  };
}

export async function probeClaudeAuthStatusCli(options: {
  binaryPath: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}): Promise<{ loggedIn: boolean; detail: string; authMethod?: string } | null> {
  const binaryPath = options.binaryPath.trim();
  if (!binaryPath) return null;

  const result = await runCliProbe(binaryPath, ["auth", "status", "--json"], {
    env: buildClaudeCodeChildEnv(options.env || process.env),
    timeoutMs: 6000,
  });
  if (result.failed && !result.stdout.trim()) return null;

  const output = result.stdout.trim();
  if (!output) return { loggedIn: false, detail: "auth-status-empty" };

  let payload: unknown;
  try {
    payload = JSON.parse(output);
  } catch {
    const start = output.indexOf("{");
    const end = output.lastIndexOf("}");
    if (start < 0 || end <= start) {
      return { loggedIn: false, detail: "auth-status-parse-error" };
    }
    try {
      payload = JSON.parse(output.slice(start, end + 1));
    } catch {
      return { loggedIn: false, detail: "auth-status-parse-error" };
    }
  }

  return interpretClaudeAuthStatus(payload);
}

export async function detectClaudeCode(options?: {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  homeDir?: string;
  binaryPath?: string | null;
}): Promise<ClaudeDetectResult> {
  const env = options?.env ?? process.env;
  const binaryPath =
    options?.binaryPath !== undefined
      ? options.binaryPath
      : await resolveClaudeCli(env);

  if (!binaryPath) {
    return {
      status: "missing-cli",
      statusDetail:
        "Claude Code CLI (`claude`) not found — install it via the provider's install action or with `npm install -g @anthropic-ai/claude-code`.",
      binaryPath: null,
      version: null,
      sdkAvailable: false,
      loggedIn: false,
    };
  }

  const versionRun = await runCliProbe(binaryPath, ["--version"], {
    env: buildClaudeCodeChildEnv(env),
    timeoutMs: 4000,
  });
  const versionOutput = versionRun.stdout.trim();
  const version =
    versionOutput.match(/(\d+\.\d+\.\d+)/)?.[1] ?? (versionOutput || null);

  const sdk = await probeClaudeAgentSdk();
  if (!sdk.available) {
    return {
      status: "missing-sdk",
      statusDetail: sdk.error || "Claude Agent SDK unavailable",
      binaryPath,
      version,
      sdkAvailable: false,
      loggedIn: false,
    };
  }

  const authStatus = await probeClaudeAuthStatusCli({ binaryPath, env });
  const loggedIn = Boolean(authStatus?.loggedIn);

  if (!loggedIn) {
    return {
      status: "needs-login",
      statusDetail:
        "Claude Code is installed but not logged in with a subscription. Run `claude auth login`.",
      binaryPath,
      version,
      sdkAvailable: true,
      loggedIn: false,
    };
  }

  return {
    status: "ready",
    statusDetail: authStatus?.detail || "ready",
    binaryPath,
    version,
    sdkAvailable: true,
    loggedIn: true,
  };
}

export { resolveClaudeCodeExecutable } from "./executable-path.js";
