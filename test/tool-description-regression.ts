/**
 * Regression: the subagent list OpenCode appends to its subagent tool
 * description must survive Claude Code's MCP description cut, in
 * the served tools/list too. (Ported from the fork's 16f9a4c, extended to
 * V2's `subagent` tool and "Available subagents:" heading.)
 *
 * Run: bun test/tool-description-regression.ts
 */
import { assert, mcpExtra, mcpHandlers } from "./helpers.ts";

async function main() {
  const { fitToolDescription, CLAUDE_TOOL_DESCRIPTION_LIMIT, buildOpenCodeMcpServer } =
    await import("../src/proxy.ts");

  const guidance =
    "Launch a new agent to handle complex, multistep tasks autonomously.\n\n" +
    "When to use the Task tool:\n".concat("- guidance line\n".repeat(Math.ceil(CLAUDE_TOOL_DESCRIPTION_LIMIT / 16) + 10));
  for (const heading of [
    "Available agent types and the tools they have access to:",
    "Available subagents:",
  ]) {
    const agents = [
      heading,
      "- general: General-purpose agent for multi-step tasks.",
      "- explore: Fast codebase exploration agent.",
      "- critic: Reviews plans and code.",
    ].join("\n");
    const taskDescription = `${guidance}\n\n${agents}`;
    assert.ok(taskDescription.length > CLAUDE_TOOL_DESCRIPTION_LIMIT);
    // Unpatched, the cut drops every agent.
    assert.ok(!taskDescription.slice(0, CLAUDE_TOOL_DESCRIPTION_LIMIT).includes("critic"));

    const fitted = fitToolDescription(taskDescription);
    const visible = fitted.slice(0, CLAUDE_TOOL_DESCRIPTION_LIMIT);
    for (const name of ["general", "explore", "critic"]) {
      assert.ok(visible.includes(`- ${name}:`), `${name} visible after the cut`);
    }
    // Guidance is kept (after the list), nothing is dropped by us.
    assert.ok(fitted.includes(guidance.trim()));
    assert.ok(fitted.includes(agents));
    assert.ok(visible.includes("Launch a new agent"));

    // Short descriptions and descriptions without the list are untouched.
    const short = `Short guidance.\n\n${agents}`;
    assert.equal(fitToolDescription(short), short);

    // The served tools/list carries the fitted description.
    const servers: any = await buildOpenCodeMcpServer(
      [{ type: "function", function: { name: "subagent", description: taskDescription, parameters: { type: "object", properties: {} } } }] as any,
      new Map(),
      () => {},
    );
    const listed = await mcpHandlers({ mcpServers: servers }).get("tools/list")!(
      { method: "tools/list", params: {} },
      mcpExtra,
    );
    assert.equal(listed.tools[0].description, fitted);
    assert.equal(servers.opencode.instance._registeredTools.subagent.description, fitted);
  }
  const long = "x".repeat(CLAUDE_TOOL_DESCRIPTION_LIMIT + 10);
  assert.equal(fitToolDescription(long), long);

  console.log("ok — tool description regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
