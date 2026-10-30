/**
 * Claude Code cuts MCP tool descriptions at 2048 chars by default (4096 from
 * 2.1.296), which hid the end of OpenChamber's longer tool instructions. The
 * child env must raise the limit unless the user set their own.
 *
 * Run: bun test/mcp-description-limit-regression.ts
 */
import assert from "node:assert/strict";
import { buildClaudeCodeChildEnv, MCP_DESCRIPTION_LIMIT, MCP_OUTPUT_LIMIT } from "../src/auth-env.ts";

const env = buildClaudeCodeChildEnv({ PATH: "/bin" });
assert.equal(env.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH, String(MCP_DESCRIPTION_LIMIT));
assert.ok(MCP_DESCRIPTION_LIMIT >= 5132 + 1000, "room for openchamber_render's full description");

const own = buildClaudeCodeChildEnv({ CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH: "3000" });
assert.equal(own.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH, "3000", "the user's limit wins");

// Tool results: past 25000 tokens Claude Code saved a 51k-character OpenCode
// result to a file and gave Claude a path it could not read (tools are off).
assert.equal(env.MAX_MCP_OUTPUT_TOKENS, String(MCP_OUTPUT_LIMIT));
assert.equal(buildClaudeCodeChildEnv({ MAX_MCP_OUTPUT_TOKENS: "30000" }).MAX_MCP_OUTPUT_TOKENS, "30000", "the user's limit wins");

console.log("ok — mcp description limit regression passed");
