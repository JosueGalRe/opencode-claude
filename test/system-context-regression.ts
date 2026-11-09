/**
 * Regression for #6: a custom OpenCode agent prompt, instructions files, MCP
 * notes and the skills list must reach Claude (appended to the Claude Code
 * preset), while OpenCode's stock base prompt and <env> block stay out.
 *
 * Run: bun test/system-context-regression.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROXY_TOKEN_HEADER, SYSTEM_PREPARED_HEADER } from "../src/constants.ts";

const ENV_BLOCK = [
  "You are powered by the model named claude-sonnet. The exact model ID is claude-code/sonnet",
  "Here is some useful information about the environment you are running in:",
  "<env>",
  "  Working directory: /repo",
  "  Platform: linux",
  "</env>",
].join("\n");
const INSTRUCTIONS = "Instructions from: /repo/AGENTS.md\n# Rules\n- Run tests sequentially.";
const SKILLS = "<available_skills>\n  <skill><name>pdf</name></skill>\n</available_skills>";

async function main() {
  const { turnSystemPrompt, openCodeSystemContext, systemContextFromParts, hasInstructionSources } = await import(
    "../src/system-context.ts"
  );

  // Stock agent: base prompt + env dropped, user config kept.
  const stock = openCodeSystemContext([
    {
      role: "system",
      content: `You are OpenCode, the best coding agent on the planet.\n\nLong stock guidance...\n${ENV_BLOCK}\n${INSTRUCTIONS}\n\n${SKILLS}`,
    },
    { role: "user", content: "hi" },
  ]);
  assert.ok(!stock.includes("best coding agent"), "stock base prompt skipped");
  assert.ok(!stock.includes("Working directory"), "env block skipped");
  assert.ok(!stock.includes("# Agent role"));
  assert.match(stock, /Run tests sequentially/);
  assert.match(stock, /<name>pdf<\/name>/);

  // Custom agent: its prompt replaces the base prompt and must be forwarded.
  const custom = openCodeSystemContext([
    {
      role: "system",
      content: `You are a harsh reviewer. End every answer with a verdict.\n${ENV_BLOCK}\n${INSTRUCTIONS}`,
    },
  ]);
  assert.match(custom, /# Agent role[\s\S]*harsh reviewer/);
  assert.match(custom, /Run tests sequentially/);
  assert.ok(!custom.includes("Working directory"));

  // V2 (2.2.3+) is read by structure: part 0 is the agent's prompt, the
  // identity plugin's "# Your Model" is a part of its own, the instructions
  // part lists its sources by key, plugins push parts after it.
  const CODE_MODE = "# Code Mode\n\nThe catalog is complete. Do not guess tool names.\n\n## Code Mode tools (call only inside `execute`)\n\n- railway (1 tool)\n  - tools.railway.whoami(): Promise<unknown>";
  const source = (key: string, text: string) => ({ key, text });
  const v2Parts = (base: string, sources = [
    source("core/codemode", CODE_MODE),
    source("core/mcp-guidance", "<mcp_instructions>\n  <server name=\"ctx\">\n    Use ctx wisely.\n  </server>\n</mcp_instructions>"),
    source("core/skill-guidance", `Skills provide specialized instructions and workflows for specific tasks.\n${SKILLS}`),
    source("core/instructions", INSTRUCTIONS),
    source("openchamber.guidance", '<context key="openchamber.guidance">\nLink each pull request you open with session.link.\n</context>'),
    source("core/date", "Today's date: Thu Oct 01 2026"),
    source("core/environment", "Here is some useful information about the environment you are running in:\n<env>\n  Working directory: /repo\n  Platform: linux\n</env>"),
  ]) => [
    { text: base },
    { text: "# Your Model\n- Name: Claude Opus 5.5\n- Provider ID: claude-code\n- Model ID: claude-opus-5-5" },
    { text: sources.map((s) => s.text).join("\n\n"), metadata: { experimental: { instructions: sources } } },
    { text: "PONYTAIL MODE ACTIVE" },
  ];
  const STOCK_V2 = "You are an AI agent running in OpenCode, a coding agent harness.\n\n# Harness\n- Prefer dedicated tools.";
  const OPENCODE_BLOCKS = /coding agent harness|Your Model|Model ID|Working directory|<env>|Today's date/;

  assert.equal(hasInstructionSources(v2Parts(STOCK_V2)), true);
  assert.equal(hasInstructionSources([{ text: `${STOCK_V2}\n# Your Model\n- Name: X` }]), false, "pre-2.2.3 V2 has no keyed sources");

  const v2Stock = systemContextFromParts(v2Parts(STOCK_V2), "", ["read"], "/nonexistent");
  for (const kept of [/Run tests sequentially/, /<name>pdf<\/name>/, /Use ctx wisely/, /PONYTAIL MODE ACTIVE/, /<context key="openchamber\.guidance">\nLink each pull request/]) {
    assert.match(v2Stock, kept);
  }
  assert.doesNotMatch(v2Stock, OPENCODE_BLOCKS);
  assert.doesNotMatch(v2Stock, /Code Mode|tools\.railway|# Agent role/, "catalog only with execute");

  const v2Execute = systemContextFromParts(v2Parts(STOCK_V2), "", ["execute"], "/nonexistent");
  assert.equal(v2Execute.match(/^# Code Mode$/gm)?.length, 1);
  assert.match(v2Execute, /tools\.railway\.whoami\(\): Promise<unknown>\n\nThe `execute` tool above is mcp__opencode__execute\./);
  assert.ok(v2Execute.indexOf("tools.railway") < v2Execute.indexOf("Run tests sequentially"));
  assert.doesNotMatch(v2Execute, OPENCODE_BLOCKS);

  // A custom agent's prompt is forwarded whatever its wording: one that opens
  // like the stock prompt, or has its own "# Your Model" heading. The stock
  // identity part still stays out.
  const role = "You are OpenCode's release bot.\n\n# Your Model\nAlways answer as a release manager.";
  const v2Custom = systemContextFromParts(v2Parts(role), role, ["read"], "/nonexistent");
  assert.match(v2Custom, /# Agent role[\s\S]*release bot[\s\S]*Always answer as a release manager/);
  assert.match(v2Custom, /Instructions from: \/repo\/AGENTS.md\n# Rules\n- Run tests sequentially/);
  assert.doesNotMatch(v2Custom, /Model ID|Provider ID|Working directory|Today's date/);

  // User instructions that quote OpenCode's wording stay whole.
  const quoting = v2Parts(STOCK_V2).map((part) => {
    const sources = (part as { metadata?: any }).metadata?.experimental.instructions;
    if (!sources) return part;
    const next = sources.map((s: { key: string; text: string }) =>
      s.key === "core/instructions" ? { ...s, text: `${s.text}\n\nToday's date: write it as ISO.\n\n<env>\n  FOO=bar\n</env>` } : s);
    return { text: part.text, metadata: { experimental: { instructions: next } } };
  });
  const quoted = systemContextFromParts(quoting, "", ["read"], "/nonexistent");
  assert.match(quoted, /Today's date: write it as ISO\.\n\n<env>\n  FOO=bar\n<\/env>/);
  assert.doesNotMatch(quoted, /Working directory|Thu Oct 01 2026/);

  // Prepared text reaches the preset as is, after the bridged-tool rules.
  const prepared = turnSystemPrompt(null, [{ role: "system", content: v2Execute }], ["execute"], undefined, true);
  assert.ok(typeof prepared !== "string");
  assert.match(prepared.append ?? "", /^You are running inside OpenCode/);
  assert.ok(prepared.append?.endsWith(`\n\n${v2Execute}`));

  // Instruction files Claude Code loads itself for the turn's directory are
  // left to it; the rest of OpenCode's instructions still go.
  const files = mkdtempSync(join(tmpdir(), "opencode-claude-instructions-"));
  const project = join(files, "project");
  mkdirSync(join(project, "sub"), { recursive: true });
  mkdirSync(join(files, "claude"), { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = join(files, "claude");
  const write = (path: string, text: string) => (writeFileSync(path, text), path);
  write(join(files, "claude", "CLAUDE.md"), "Global Claude rules.\n");
  const agents = write(join(project, "AGENTS.md"), "Project agents rules.\n\nSecond paragraph.\n");
  const claudeMd = write(join(project, "CLAUDE.md"), "Project Claude rules.\n");
  const linked = join(files, "linked.md");
  symlinkSync(claudeMd, linked);
  const copy = write(join(files, "copy.md"), "Global Claude rules.\n");
  const global = write(join(files, "opencode-AGENTS.md"), "Call me Bryan.\n");
  const stale = write(join(files, "stale.md"), "Changed on disk.\n");
  const block = (path: string, text: string) => `Instructions from: ${path}\n${text}`;
  const instructions = [
    block(agents, "Project agents rules.\n\nSecond paragraph."),
    block(global, "Call me Bryan."),
    block(linked, "Project Claude rules."),
    block(copy, "Global Claude rules."),
    block(stale, "What OpenCode loaded."),
  ].join("\n\n");
  const withFiles = v2Parts(STOCK_V2, [source("core/instructions", instructions)]);
  const deduped = systemContextFromParts(withFiles, "", [], join(project, "sub"));
  assert.match(deduped, /Call me Bryan/);
  assert.match(deduped, /What OpenCode loaded/);
  assert.doesNotMatch(deduped, /Project agents rules|Second paragraph|Project Claude rules|Global Claude rules/);
  assert.doesNotMatch(deduped, /project\/AGENTS\.md|linked\.md|copy\.md|\n{3,}/);
  // Outside the project only the global CLAUDE.md is Claude Code's own.
  const outside = systemContextFromParts(withFiles, "", [], files);
  assert.match(outside, /Second paragraph[\s\S]*Project Claude rules/);
  assert.doesNotMatch(outside, /Global Claude rules/);

  // A CLAUDE.md that `@path`-imports a file (nested, `~/`-free here) makes
  // Claude Code load it; an import inside a code span is only text.
  mkdirSync(join(files, "imports"));
  write(join(files, "imports", "chain-b.md"), "Chained rules.\n");
  write(join(files, "imports", "chain-a.md"), "See @./chain-b.md for the chain.\n");
  const chained = write(join(files, "chained.md"), "Chained rules.\n");
  const literal = write(join(files, "literal.md"), "Literal rules.\n");
  write(join(files, "claude", "CLAUDE.md"),
    `@${global}\n\n- chain @${join(files, "imports", "chain-a.md")}\n- literal \`@${literal}\`\n`);
  const imported = systemContextFromParts(
    v2Parts(STOCK_V2, [source("core/instructions", [block(global, "Call me Bryan."), block(chained, "Chained rules."), block(literal, "Literal rules.")].join("\n\n"))]),
    "",
    [],
    join(project, "sub"),
  );
  assert.doesNotMatch(imported, /Call me Bryan|Chained rules/);
  assert.match(imported, /Instructions from: [^\n]*literal\.md\nLiteral rules\./);
  delete process.env.CLAUDE_CONFIG_DIR;

  assert.equal(openCodeSystemContext([{ role: "user", content: "hi" }]), "");

  // V2 compaction carries its instructions in the user turn: the agent's
  // context stays out. V1 summary agents carry theirs in the system prompt,
  // which is kept.
  const v2Summary = String(turnSystemPrompt(
    "summary",
    [
      { role: "system", content: v2Custom },
      { role: "user", content: "Summarize the conversation above." },
    ],
    null,
    undefined,
    true,
  ));
  assert.ok(!v2Summary.includes("release bot"), "v2 compaction drops the system prompt");
  assert.match(v2Summary, /single-turn text transformation/);
  const v1Summary = String(turnSystemPrompt(
    "summary",
    [{ role: "system", content: "You are a helpful AI assistant tasked with summarizing conversations." }],
    null,
  ));
  assert.match(v1Summary, /tasked with summarizing conversations/);

  // Through the proxy: appended to the preset, and switchable off.
  const tmp = mkdtempSync(join(tmpdir(), "opencode-claude-sysctx-"));
  process.env.XDG_DATA_HOME = tmp;
  process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE = join(tmp, "rate-limit.json");
  const { startProxy, stopProxy, setClaudeQueryStarter, getProxyAuthToken } = await import(
    "../src/proxy.ts"
  );
  const port = await startProxy();
  let seen: Record<string, any> | null = null;
  setClaudeQueryStarter(async (params) => {
    seen = params as unknown as Record<string, any>;
    return {
      stream: (async function* () {
        yield { type: "system", subtype: "init", session_id: "sysctx-sess" };
        yield { type: "result", is_error: false, usage: {} };
      })(),
      close: () => {},
    };
  });
  const send = async (session: string, system = `You are a harsh reviewer.\n${ENV_BLOCK}\n${INSTRUCTIONS}`, extra: Record<string, string> = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [PROXY_TOKEN_HEADER]: getProxyAuthToken(),
        "x-opencode-claude-session": session,
        ...extra,
      },
      body: JSON.stringify({
        model: "sonnet",
        stream: false,
        tools: [
          {
            type: "function",
            function: {
              name: "bash",
              description: "Run a command",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        messages: [
          { role: "system", content: system },
          { role: "user", content: "review this" },
        ],
      }),
    });
    assert.equal(res.status, 200);
    return seen!.systemPrompt as { preset?: string; append?: string };
  };

  try {
    const on = await send("sysctx-on");
    assert.equal(on.preset, "claude_code");
    // Chat turns keep the user's Claude Code memory; only utility turns drop it.
    assert.equal((seen!.env as Record<string, unknown>).CLAUDE_CODE_DISABLE_AUTO_MEMORY, undefined);
    assert.match(on.append ?? "", /mcp__opencode__/);
    assert.match(on.append ?? "", /harsh reviewer/);
    assert.match(on.append ?? "", /Run tests sequentially/);

    // V2: the hooks' text is forwarded as is, not read a second time.
    const v2 = await send("sysctx-v2", v2Custom, { [SYSTEM_PREPARED_HEADER]: "1" });
    assert.ok(v2.append?.endsWith(`\n\n${v2Custom}`));
    assert.equal(v2.append?.match(/# OpenCode context/g)?.length, 1);

    process.env.OPENCODE_CLAUDE_FORWARD_SYSTEM_CONTEXT = "0";
    const off = await send("sysctx-off");
    assert.ok(!(off.append ?? "").includes("harsh reviewer"));
    assert.match(off.append ?? "", /mcp__opencode__/);
  } finally {
    delete process.env.OPENCODE_CLAUDE_FORWARD_SYSTEM_CONTEXT;
    await stopProxy();
  }
  console.log("ok — system context regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
