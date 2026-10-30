/**
 * Subscription-only child env for Claude Code (from OpenChamber harness).
 * Never log env values — this module only returns sanitized copies.
 */

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
 * Tokens of one MCP tool result Claude Code passes to the model. Past its
 * default (25000) it saves the result to a file and hands Claude a path it
 * cannot read: the built-in tools are off. OpenCode truncates its own tool
 * output already, so its result goes through whole. A value the user set wins.
 */
export const MCP_OUTPUT_LIMIT = 200_000;

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
  return env;
}
