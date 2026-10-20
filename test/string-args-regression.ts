/**
 * Regression: Claude sometimes sends typed tool arguments as their string
 * encoding ("true", "300000", a JSON array), and the bridge's validation
 * answered -32602 before OpenCode saw the call. String-encoded arguments for
 * parameters that cannot take a string reach OpenCode decoded; values that do
 * not decode are still rejected. (Ported from upstream 1.5.0, 7140699.)
 *
 * Run: bun test/string-args-regression.ts
 */
import assert from "node:assert/strict";

const fn = (name: string, properties: Record<string, unknown>, required: string[] = []) => ({
  type: "function",
  function: {
    name,
    description: name,
    parameters: { type: "object", properties, required, additionalProperties: false },
  },
});

async function main() {
  const { buildOpenCodeMcpServer, coerceStringArgument } = await import("../src/tool-bridge.ts");
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  const { z } = await import("zod");

  const tools = [
    fn("subagent", { agent: { type: "string" }, prompt: { type: "string" }, background: { type: "boolean" } }, ["agent", "prompt"]),
    fn("shell", { command: { type: "string" }, timeout: { type: "integer", minimum: 0 } }, ["command"]),
    fn("question", { questions: { type: "array", minItems: 1, items: { type: "object", properties: { header: { type: "string" } }, required: ["header"] } } }, ["questions"]),
    fn("compress", { content: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] } }),
    // z.fromJSONSchema cannot resolve the $ref, so this tool takes the fallback shape.
    fn("fallback", { n: { type: "integer" }, r: { $ref: "#/$defs/missing" } }, ["n"]),
    fn("defaults", { limit: { type: "integer", default: 5 }, all: { type: "boolean", default: false }, n: { type: ["integer", "null"] } }, ["all"]),
  ];
  const pending = new Map<string, any>();
  const servers = await buildOpenCodeMcpServer(tools as any, pending, () => {
    for (const [id, tool] of pending) {
      pending.delete(id);
      tool.resolve([{ type: "text", text: tool.arguments }]);
    }
  });
  const handlers = (servers!.opencode as any).instance.server._requestHandlers as Map<string, Function>;
  const call = (name: string, args: Record<string, unknown>) =>
    handlers.get("tools/call")!(
      { method: "tools/call", params: { name, arguments: args } },
      { signal: new AbortController().signal },
    );
  const sent = async (name: string, args: Record<string, unknown>) => {
    const result: any = await call(name, args);
    assert.ok(!result.isError, `${name} ${JSON.stringify(args)}: ${result.content[0].text}`);
    return JSON.parse(result.content[0].text);
  };
  const rejected = async (name: string, args: Record<string, unknown>) => {
    const result: any = await call(name, args);
    assert.ok(result.isError, `${name} ${JSON.stringify(args)} should be rejected`);
    assert.match(result.content[0].text, /Input validation error/);
  };

  // String encodings reach OpenCode as the declared type.
  assert.deepEqual(await sent("subagent", { agent: "a", prompt: "p", background: "true" }), { agent: "a", prompt: "p", background: true });
  assert.deepEqual(await sent("subagent", { agent: "a", prompt: "p", background: "false" }), { agent: "a", prompt: "p", background: false });
  assert.deepEqual(await sent("shell", { command: "c", timeout: "300000" }), { command: "c", timeout: 300000 });
  assert.deepEqual(await sent("question", { questions: '[{"header":"h"}]' }), { questions: [{ header: "h" }] });
  assert.deepEqual(await sent("fallback", { n: "5" }), { n: 5 });
  assert.deepEqual(await sent("defaults", { all: "true", n: "null" }), { limit: 5, all: true, n: null });

  // Schema defaults still apply to omitted arguments, required or not.
  assert.deepEqual(await sent("defaults", {}), { limit: 5, all: false });

  // Typed values, omitted optionals and strings where strings are allowed
  // pass through unchanged.
  assert.deepEqual(await sent("subagent", { agent: "a", prompt: "p", background: true }), { agent: "a", prompt: "p", background: true });
  assert.deepEqual(await sent("subagent", { agent: "a", prompt: "p" }), { agent: "a", prompt: "p" });
  assert.deepEqual(await sent("compress", { content: "[1]" }), { content: "[1]" });

  // Values that do not decode to the declared type are still rejected.
  await rejected("subagent", { agent: "a", prompt: "p", background: "yes" });
  await rejected("shell", { command: "c", timeout: "abc" });
  await rejected("shell", { command: "c", timeout: "1.5" });
  await rejected("question", { questions: '{"header":"h"}' });
  await rejected("subagent", { prompt: "p" });
  await rejected("fallback", {});

  // tools/list is what the same schemas list without the coercion.
  const listed = await handlers.get("tools/list")!({ method: "tools/list", params: {} }, {});
  const plain = sdk.createSdkMcpServer({
    name: "plain",
    tools: tools
      .filter((t) => t.function.name !== "fallback")
      .map((t) => sdk.tool(t.function.name, t.function.name, (z as any).fromJSONSchema(t.function.parameters).shape, async () => ({ content: [] }))),
  }) as any;
  const plainListed = await plain.instance.server._requestHandlers.get("tools/list")({ method: "tools/list", params: {} }, {});
  for (const tool of plainListed.tools) {
    assert.deepEqual(listed.tools.find((t: any) => t.name === tool.name)?.inputSchema, tool.inputSchema, tool.name);
  }

  // Union types: a type that takes strings keeps them, null decodes.
  assert.equal(coerceStringArgument("true", { type: ["boolean", "string"] }), "true");
  assert.equal(coerceStringArgument("null", { type: ["integer", "null"] }), null);
  assert.equal(coerceStringArgument(" 7 ", { type: "number" }), 7);
  assert.equal(coerceStringArgument("7", {}), "7");

  console.log("ok — string-encoded tool args regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
