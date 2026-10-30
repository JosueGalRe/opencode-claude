/**
 * Claude Code saves an MCP tool result to a file and gives Claude only its
 * path, which Claude cannot read with the built-in tools off, when the result
 * passes either cap: 25000 tokens (MAX_MCP_OUTPUT_TOKENS) or 50,000
 * characters (raised per tool by `_meta["anthropic/maxResultSizeChars"]`, up
 * to 500,000). OpenCode truncates its own tool output, so the plugin raises
 * both: the child env sets the token cap unless the user set their own, and
 * every bridged tool declares the character cap in tools/list.
 *
 * Run: bun test/mcp-output-limit-regression.ts
 */
import assert from "node:assert/strict";
import { buildClaudeCodeChildEnv, MCP_OUTPUT_LIMIT, MCP_RESULT_SIZE_LIMIT } from "../src/auth-env.ts";

async function main() {
  const env = buildClaudeCodeChildEnv({ PATH: "/bin" });
  assert.equal(env.MAX_MCP_OUTPUT_TOKENS, String(MCP_OUTPUT_LIMIT));
  assert.ok(MCP_OUTPUT_LIMIT > 25_000, "above Claude Code's default");
  const own = buildClaudeCodeChildEnv({ MAX_MCP_OUTPUT_TOKENS: "30000" });
  assert.equal(own.MAX_MCP_OUTPUT_TOKENS, "30000", "the user's limit wins");

  const { buildOpenCodeMcpServer } = await import("../src/tool-bridge.ts");
  const tools = ["bash", "read"].map((name) => ({
    type: "function",
    function: { name, description: name, parameters: { type: "object", properties: {} } },
  }));
  const servers = await buildOpenCodeMcpServer(tools, new Map(), () => {});
  const handlers = (servers!.opencode as any).instance.server._requestHandlers as Map<string, Function>;
  const listed = await handlers.get("tools/list")!({ method: "tools/list", params: {} }, {});
  assert.equal(listed.tools.length, 2);
  for (const tool of listed.tools) {
    assert.equal(tool._meta?.["anthropic/maxResultSizeChars"], MCP_RESULT_SIZE_LIMIT, tool.name);
    assert.equal(tool._meta?.["anthropic/alwaysLoad"], true, tool.name);
  }
  assert.ok(MCP_RESULT_SIZE_LIMIT > 50_000 && MCP_RESULT_SIZE_LIMIT <= 500_000, "within the CLI's 500,000 ceiling");

  console.log("ok — mcp output limit regression passed");
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
