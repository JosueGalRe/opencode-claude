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
import { PROXY_TOKEN_HEADER } from "../src/constants.ts";

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
  const { turnSystemPrompt, openCodeSystemContext } = await import(
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

  // V2 stock agent: model/env sections are Anthropic's third-party
  // fingerprint; the Code Mode catalog is forwarded only with execute.
  const v2Env = [
    "# Your Model",
    "- Name: Sonnet 5",
    "- Provider ID: claude-code",
    "Here is some useful information about the environment you are running in:",
    "<env>",
    "  Working directory: /repo",
    "</env>",
    "Today's date: Tue Sep 22 2026",
    "# Code Mode",
    "Use the `execute` tool to call the tools listed below. They cannot be called directly, and neither can `search`. Both only work inside code you pass to `execute`.",
    "The catalog is partial. Inside `execute`, use `search(...)` to find a tool, then call it by the `path` in the result. `search` is synchronous. Call it without `await`; it does not return a Promise. Do not guess tool names.",
    "## Available tools",
    "- railway (47 tools, 1 shown)",
    "  - tools.railway.whoami(): Promise<unknown>",
    "- openchamber (1 tool)",
    "  - tools.openchamber({ action }): Promise<string | null>",
  ].join("\n");
  const v2Stock = openCodeSystemContext([
    {
      role: "system",
      content: `You are an AI agent running in OpenCode, a coding agent harness.\n\n# Harness\n- Prefer dedicated tools.\n${v2Env}\n\n${INSTRUCTIONS}\n\n${SKILLS}`,
    },
    { role: "user", content: "hi" },
  ]);
  assert.ok(!v2Stock.includes("coding agent harness"), "v2 stock base skipped");
  assert.ok(!v2Stock.includes("Your Model"), "v2 model section skipped");
  assert.ok(!v2Stock.includes("Working directory"), "v2 env block skipped");
  assert.ok(!v2Stock.includes("Code Mode"), "v2 code-mode catalog skipped");
  assert.ok(!v2Stock.includes("Today's date"), "v2 date line skipped");
  assert.ok(!v2Stock.includes("# Agent role"));
  assert.match(v2Stock, /Run tests sequentially/);
  assert.match(v2Stock, /<name>pdf<\/name>/);

  const v2Messages = [{ role: "system", content: `You are an AI agent running in OpenCode, a coding agent harness.\n\n${v2Env}\n\n${INSTRUCTIONS}\n\n${SKILLS}` }];
  const noExecute = turnSystemPrompt(null, v2Messages, ["read"]);
  assert.ok(typeof noExecute !== "string");
  assert.ok(!noExecute.append?.includes("tools.railway"));
  assert.match(noExecute.append ?? "", /Run tests sequentially/);

  const withExecute = turnSystemPrompt(null, v2Messages, ["execute"]);
  assert.ok(typeof withExecute !== "string");
  const append = withExecute.append ?? "";
  assert.match(append, /tools\.railway\.whoami/);
  assert.match(append, /tools\.openchamber/);
  assert.equal(append.match(/# Code Mode/g)?.length, 1);
  assert.match(append, /mcp__opencode__execute/);
  assert.match(append, /Run tests sequentially/);
  assert.match(append, /<name>pdf<\/name>/);
  assert.ok(append.indexOf("tools.openchamber") < append.indexOf("Run tests sequentially"));
  assert.doesNotMatch(append, /# Your Model|Working directory|Today's date|coding agent harness/);

  // Sections after the catalog are user or plugin configuration.
  const noInstructions = turnSystemPrompt(null, [
    { role: "system", content: `You are an AI agent running in OpenCode.\n\n${v2Env}\n# Skills\nprivate rules` },
  ], ["execute"]);
  assert.ok(typeof noInstructions !== "string");
  assert.match(noInstructions.append ?? "", /tools\.railway\.whoami/);
  assert.match(noInstructions.append ?? "", /# Skills\nprivate rules/);
  assert.equal(noInstructions.append?.match(/tools\.railway\.whoami/g)?.length, 1);

  // V2 2.0.19+: Code Mode, MCP notes, skills and instructions come before
  // the date and <env>; plugins append after them; later changes arrive as
  // extra system messages.
  const v2Next = [
    { role: "system", content: "You are an AI agent running in OpenCode, a coding agent harness." },
    { role: "system", content: "# Your Model\n- Name: Claude Opus 5.5\n- Provider ID: claude-code\n- Model ID: claude-opus-5-5" },
    {
      role: "system",
      content: [
        "# Code Mode",
        "",
        "Use the `execute` tool to call the tools listed below. They cannot be called directly. They only work inside code you pass to `execute`.",
        "",
        "The catalog is complete. Do not guess tool names.",
        "",
        "## Available tools",
        "",
        "- railway (1 tool)",
        "  - tools.railway.whoami(): Promise<unknown>",
        "",
        "<mcp_instructions>\n  <server name=\"ctx\">\n    Use ctx wisely.\n  </server>\n</mcp_instructions>",
        "",
        `Skills provide specialized instructions and workflows for specific tasks.\n${SKILLS}`,
        "",
        INSTRUCTIONS,
        "",
        "Today's date: Thu Oct 01 2026",
        "",
        "Here is some useful information about the environment you are running in:\n<env>\n  Working directory: /repo\n  Platform: linux\n</env>",
      ].join("\n"),
    },
    { role: "system", content: "PONYTAIL MODE ACTIVE" },
    { role: "user", content: "hi" },
    { role: "system", content: "Today's date is now: Fri Oct 02 2026" },
    { role: "system", content: "The environment you are running in is now:\n<env>\n  Working directory: /other\n</env>" },
  ];
  const v2NextContext = openCodeSystemContext(v2Next);
  for (const kept of [/Run tests sequentially/, /<name>pdf<\/name>/, /Use ctx wisely/, /PONYTAIL MODE ACTIVE/]) {
    assert.match(v2NextContext, kept);
  }
  assert.doesNotMatch(v2NextContext, /Your Model|Model ID|Working directory|<env>|Today's date|Code Mode|tools\.railway|coding agent harness|# Agent role/);
  const v2NextExecute = turnSystemPrompt(null, v2Next, ["execute"]);
  assert.ok(typeof v2NextExecute !== "string");
  assert.equal(v2NextExecute.append?.match(/# Code Mode/g)?.length, 1);
  assert.match(v2NextExecute.append ?? "", /tools\.railway\.whoami\(\): Promise<unknown>\n\nThe `execute` tool above/);
  assert.match(v2NextExecute.append ?? "", /Run tests sequentially/);
  assert.doesNotMatch(v2NextExecute.append ?? "", /Your Model|Working directory|Today's date/);
  const v2NextRead = turnSystemPrompt(null, v2Next, ["read"]);
  assert.ok(typeof v2NextRead !== "string");
  assert.doesNotMatch(v2NextRead.append ?? "", /tools\.railway|Code Mode/);

  // The catalog ends with its listing (upstream #35): multi-line signatures
  // stay, a partial catalog's search guidance stays, CRLF and a heading or
  // whitespace-only line end it, unheaded sections after it don't join it.
  const catalog = [
    "# Code Mode", "", "The catalog is partial. Use `search(...)` to find a tool.", "", "- search(query: string)", "",
    "## Available tools", "", "- demo (2 tools) // Example tools",
    "  - tools.demo.read({", "  path: string,", "}): Promise<string> // Read a file",
    "  - tools.demo.status(): Promise<string>",
  ].join("\n");
  const catalogOf = (after: string, sep = "\n\n") => {
    const prompt = turnSystemPrompt(null, [
      { role: "system", content: "You are an AI agent running in OpenCode." },
      { role: "system", content: "# Your Model\n- Name: X" },
      { role: "system", content: `${catalog.replaceAll("\n", sep === "\r\n \t\r\n" ? "\r\n" : "\n")}${sep}${after}` },
    ], ["execute"]);
    assert.ok(typeof prompt !== "string");
    return prompt.append?.match(/# Code Mode[\s\S]*?(?=\n\nThe `execute` tool above)/)?.[0];
  };
  const envAfter = "Today's date: Thu Oct 01 2026\n\nHere is some useful information about the environment you are running in:\n<env>\n</env>";
  for (const after of [envAfter, "<mcp_instructions>m</mcp_instructions>\n\n" + envAfter, "Some plugin note\n\n" + envAfter]) {
    assert.equal(catalogOf(after), catalog);
  }
  assert.equal(catalogOf(`# Other instructions\nExample\n\n${envAfter}`, "\n"), catalog);
  assert.equal(catalogOf(`## Other instructions\nExample\n\n${envAfter}`, "\n"), catalog);
  assert.equal(catalogOf(envAfter, "\r\n \t\r\n"), catalog.replaceAll("\n", "\r\n"));

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
  const withFiles = [
    { role: "system", content: "You are an AI agent running in OpenCode." },
    { role: "system", content: `# Your Model\n- Name: X\n\n${instructions}\n\nHere is some useful information about the environment you are running in:\n<env>\n</env>` },
  ];
  const deduped = openCodeSystemContext(withFiles, join(project, "sub"));
  assert.match(deduped, /Call me Bryan/);
  assert.match(deduped, /What OpenCode loaded/);
  assert.doesNotMatch(deduped, /Project agents rules|Second paragraph|Project Claude rules|Global Claude rules/);
  assert.doesNotMatch(deduped, /project\/AGENTS\.md|linked\.md|copy\.md|\n{3,}/);
  assert.match(openCodeSystemContext(withFiles), /Second paragraph[\s\S]*Global Claude rules/);
  delete process.env.CLAUDE_CONFIG_DIR;

  // V2 custom agent: its prompt replaces the stock opener and is forwarded.
  const v2Custom = openCodeSystemContext([
    {
      role: "system",
      content: `You are a pirate tester.\n${v2Env}\n\n${INSTRUCTIONS}`,
    },
  ]);
  assert.match(v2Custom, /# Agent role[\s\S]*pirate tester/);
  assert.match(v2Custom, /Instructions from: \/repo\/AGENTS.md\n# Rules\n- Run tests sequentially/);
  assert.ok(!v2Custom.includes("Your Model"));
  assert.ok(!v2Custom.includes("Working directory"));

  // V2 layout without a recognizable env block: forward nothing but a custom
  // agent prompt rather than risk the third-party credential rejection.
  const v2Unparsed = openCodeSystemContext([
    {
      role: "system",
      content:
        "You are an AI agent running in OpenCode, a coding agent harness.\n# Your Model\n- Name: Sonnet 5\n(no env block in this layout)\nsecret boilerplate",
    },
  ]);
  assert.equal(v2Unparsed, "");

  assert.equal(openCodeSystemContext([{ role: "user", content: "hi" }]), "");

  // V2 compaction carries its instructions in the user turn: the agent's
  // system prompt, third-party fingerprint included, stays out. V1 summary
  // agents carry theirs in the system prompt, which is kept.
  const v2Summary = String(turnSystemPrompt(
    "summary",
    [
      { role: "system", content: `You are a pirate tester.\n${v2Env}\n${INSTRUCTIONS}` },
      { role: "user", content: "Summarize the conversation above." },
    ],
    null,
  ));
  assert.ok(!v2Summary.includes("Your Model"), "v2 compaction drops the system prompt");
  assert.ok(!v2Summary.includes("pirate tester"));
  assert.ok(!v2Summary.includes("tools.railway"));
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
  const send = async (session: string) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [PROXY_TOKEN_HEADER]: getProxyAuthToken(),
        "x-opencode-claude-session": session,
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
          {
            role: "system",
            content: `You are a harsh reviewer.\n${ENV_BLOCK}\n${INSTRUCTIONS}`,
          },
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
    assert.match(on.append ?? "", /mcp__opencode__/);
    assert.match(on.append ?? "", /harsh reviewer/);
    assert.match(on.append ?? "", /Run tests sequentially/);

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
