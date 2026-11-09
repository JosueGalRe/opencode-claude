/**
 * Subscription-only child env for Claude Code (from OpenChamber harness).
 * Never log env values — this module only returns sanitized copies.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./log.js";

/** Credential overrides removed so Claude Code uses its own login store. */
export const AUTH_OVERRIDE_ENV_KEYS = Object.freeze([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
]);

/**
 * MCP tool descriptions Claude Code sends to the model, in characters. The
 * CLI cuts them at 2048 (4096 from 2.1.296; 16384 only for tools loaded
 * through tool search, which bridged tools never are), and OpenCode and
 * OpenChamber tools run longer, so their closing instructions never reached
 * Claude. A value the user set wins.
 */
export const MCP_DESCRIPTION_LIMIT = 8192;

/**
 * Claude Code puts two caps on an MCP tool result, and past either it saves
 * the result to a file and hands Claude only the path, which Claude cannot
 * read with the built-in tools off. OpenCode truncates its own tool output
 * already, so both are raised and that truncation is the one that applies:
 * - MCP_OUTPUT_LIMIT, tokens (MAX_MCP_OUTPUT_TOKENS, default 25000; a value
 *   the user set wins);
 * - MCP_RESULT_SIZE_LIMIT, characters (each tool's
 *   `_meta["anthropic/maxResultSizeChars"]`, default 50,000, CLI max 500,000).
 */
export const MCP_OUTPUT_LIMIT = 200_000;
export const MCP_RESULT_SIZE_LIMIT = 500_000;

/**
 * Name Claude Code reports for this plugin (CLAUDE_CODE_ENTRYPOINT, sent as
 * cc_entrypoint on every request). Left unset, the Agent SDK says sdk-ts,
 * and sdk-* turns use the 5-hour window about twice as fast per token as
 * other clients (anthropics/claude-code#97074). The plugin's own name, in
 * the CLI's format for custom names; never another client's (cli,
 * claude-vscode). An inherited value (OpenCode started from a Claude
 * session) is replaced; OPENCODE_CLAUDE_ENTRYPOINT picks another, e.g. sdk-ts.
 */
export const CLAUDE_ENTRYPOINT = "josuegalre-opencode-claude";

/**
 * Build a child-process env for Claude Code subscription mode.
 * Starts from process.env (or provided base), preserves PATH, then deletes
 * credential overrides so the CLI exclusively owns authentication.
 */
export function buildClaudeCodeChildEnv(
  baseEnv: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const env = { ...baseEnv };
  for (const key of AUTH_OVERRIDE_ENV_KEYS) {
    delete env[key];
  }
  if (!env.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH?.trim()) {
    env.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH = String(MCP_DESCRIPTION_LIMIT);
  }
  if (!env.MAX_MCP_OUTPUT_TOKENS?.trim()) {
    env.MAX_MCP_OUTPUT_TOKENS = String(MCP_OUTPUT_LIMIT);
  }
  env.CLAUDE_CODE_ENTRYPOINT = env.OPENCODE_CLAUDE_ENTRYPOINT?.trim() || CLAUDE_ENTRYPOINT;
  // When a stream breaks partway, Claude Code re-sends the request without
  // streaming, and that answer's text never reaches OpenCode: the proxy reads
  // text only from stream deltas. Failing instead takes the error path.
  env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK = "1";
  return env;
}

/**
 * The string values of the `env` block in the user's Claude Code settings
 * (`$CLAUDE_CONFIG_DIR/settings.json`, default `~/.claude/settings.json`).
 * Chat turns load user settings, so the CLI applies this block itself over
 * its env. A turn that loads none (titles, other one-shot utility turns, the
 * model list) would lose a login set there (a gateway's endpoint and token,
 * Bedrock or Vertex, a proxy or CA) and fail with "Not logged in" while chats
 * work. Credentials inherited from the OpenCode process stay removed. A
 * missing file gives `{}`; an unreadable or malformed one is logged (never
 * its values) and gives `{}`.
 */
export async function readClaudeSettingsEnv(
  baseEnv: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Promise<Record<string, string>> {
  const configDir = baseEnv.CLAUDE_CONFIG_DIR?.trim() || join(baseEnv.HOME?.trim() || homedir(), ".claude");
  const file = join(configDir, "settings.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code !== "ENOENT") {
      log.warn("[opencode-claude] could not read Claude Code settings for utility turns", {
        file,
        error: code ?? (error instanceof Error ? error.name : "unknown"),
      });
    }
    return {};
  }
  const settingsEnv = (parsed as { env?: unknown } | null)?.env;
  if (!settingsEnv || typeof settingsEnv !== "object" || Array.isArray(settingsEnv)) return {};
  return Object.fromEntries(
    Object.entries(settingsEnv).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}
