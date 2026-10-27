/**
 * Claude Code turns run by the plugin report its own name as their
 * entrypoint. Left to the Agent SDK they say sdk-ts, which uses the 5-hour
 * window about twice as fast per token (anthropics/claude-code#97074).
 *
 * Run: bun test/entrypoint-regression.ts
 */
import assert from "node:assert/strict";
import { buildClaudeCodeChildEnv, CLAUDE_ENTRYPOINT } from "../src/auth-env.ts";

assert.equal(buildClaudeCodeChildEnv({ PATH: "/bin" }).CLAUDE_CODE_ENTRYPOINT, CLAUDE_ENTRYPOINT);
// OpenCode started from inside a Claude session inherits sdk-ts or sdk-cli.
for (const inherited of ["sdk-ts", "sdk-cli"]) {
  assert.equal(buildClaudeCodeChildEnv({ CLAUDE_CODE_ENTRYPOINT: inherited }).CLAUDE_CODE_ENTRYPOINT, CLAUDE_ENTRYPOINT);
}
// An explicit choice wins, including the SDK's own label.
assert.equal(buildClaudeCodeChildEnv({ OPENCODE_CLAUDE_ENTRYPOINT: "sdk-ts" }).CLAUDE_CODE_ENTRYPOINT, "sdk-ts");
// The rebuilt env of the query keeps that choice.
const rebuilt = buildClaudeCodeChildEnv(buildClaudeCodeChildEnv({ OPENCODE_CLAUDE_ENTRYPOINT: "sdk-ts" }));
assert.equal(rebuilt.CLAUDE_CODE_ENTRYPOINT, "sdk-ts");

// The CLI's format for a custom name (2.1.310), and never another client's.
assert.match(CLAUDE_ENTRYPOINT, /^(?!sdk)[a-z][a-z0-9_-]{0,31}$/);
assert.ok(!["cli", "claude-vscode", "claude-desktop", "mcp"].includes(CLAUDE_ENTRYPOINT));

console.log("ok — entrypoint regression passed");
