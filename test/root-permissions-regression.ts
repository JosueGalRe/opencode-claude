/**
 * Regression: chat turns with OpenCode tools ran Claude Code with
 * bypassPermissions, which the CLI refuses to start with as root, so the
 * plugin did not work on a root-only host. The turn now uses dontAsk with
 * the bridged OpenCode tools (and their aliases) allowed; anything else is
 * refused.
 *
 * Run: bun test/root-permissions-regression.ts
 */
import type { StartClaudeQueryParams } from "../src/query.ts";
import { assert, bashTool, mockHandle, startMockedProxy, textDelta } from "./helpers.ts";

async function main() {
  const { post, proxy, cleanup } = await startMockedProxy("root-permissions");
  let seen: StartClaudeQueryParams | null = null;
  proxy.setClaudeQueryStarter(async (params) => {
    seen = params;
    return mockHandle(
      (async function* () {
        yield textDelta("hi");
        yield { type: "result", is_error: false, usage: {} };
      })(),
    );
  });
  try {
    const res = await post("root", { tools: [bashTool], messages: [{ role: "user", content: "hi" }] });
    assert.equal(res.status, 200);
    await res.text();
    const params = seen as StartClaudeQueryParams | null;
    assert.equal(params?.permissionMode, "dontAsk");
    assert.notEqual(params?.allowDangerouslySkipPermissions, true);
    assert.deepEqual(params?.allowedTools, ["mcp__opencode__bash"]);
    assert.equal(params?.toolAliases?.Bash, "mcp__opencode__bash");
    assert.deepEqual(params?.tools, [], "no built-in tools");
  } finally {
    await cleanup();
  }
  console.log("ok — root permissions regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
