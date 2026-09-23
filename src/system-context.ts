import {
  metaPresetAppend,
  metaSystemPrompt,
  type MetaRequestKind,
} from "./request-kind.js";

type MessageLike = { role?: string; content?: unknown };

const ENV_MARKER = "You are powered by the model named";
const STOCK_BASE_PROMPT =
  /^You are (OpenCode|opencode|an AI agent running in OpenCode)\b/;
// OpenCode V2 assembles: agent prompt, "# Your Model", <env>, "Today's date",
// "# Code Mode" with the tool catalog, and only then user configuration
// ("Instructions from: …" blocks, skills list). V1 has no "# Your Model".
const V2_MODEL_MARKER = /^# Your Model$/m;
const V2_DATE_PREFIX = /^\s*Today's date:[^\n]*\n?/;
const V2_CODE_MODE = "# Code Mode";
const V2_KEEP_MARKERS = [
  "Instructions from:",
  "Skills provide specialized instructions",
];

function formatContext(head: string, rest: string): string {
  const parts: string[] = [];
  if (head) {
    parts.push(
      `# Agent role (from the OpenCode agent configuration; this defines who you are for this session and takes precedence over the generic role above)\n\n${head}`,
    );
  }
  if (rest) {
    parts.push(
      `# OpenCode context (user instructions, MCP notes, available skills)\n\n${rest}`,
    );
  }
  return parts.join("\n\n");
}

/** OPENCODE_CLAUDE_FORWARD_SYSTEM_CONTEXT=0 turns forwarding off. */
export function systemContextForwardingEnabled(): boolean {
  const raw = (process.env.OPENCODE_CLAUDE_FORWARD_SYSTEM_CONTEXT ?? "")
    .trim()
    .toLowerCase();
  return !["0", "false", "off", "no"].includes(raw);
}

/**
 * The Claude Code preset replaces OpenCode's system prompt, which also drops
 * the parts that are user configuration rather than OpenCode boilerplate: a
 * custom agent prompt (the agent's persona and rules), `instructions` files
 * and AGENTS.md, MCP server instructions and the available-skills list
 * (#6). Recover those so they can be appended to the preset. OpenCode's
 * stock base prompt and its <env> block are skipped; Claude Code supplies
 * its own equivalents.
 *
 * V2 matters doubly: its stock "# Your Model" + <env> section makes Anthropic
 * reject subscription credentials as third-party usage (400 "Third-party
 * apps…"), and its "# Code Mode" tool catalog describes an `execute` tool
 * Claude does not have. Both must never reach the Claude request.
 */
export function openCodeSystemContext(messages: MessageLike[]): string {
  const system = metaSystemPrompt(messages).trim();
  if (!system) return "";

  const v2ModelAt = system.search(V2_MODEL_MARKER);
  if (v2ModelAt >= 0) {
    let head = system.slice(0, v2ModelAt).trim();
    if (STOCK_BASE_PROMPT.test(head)) head = "";
    let rest = "";
    const envEnd = system.indexOf("</env>", v2ModelAt);
    if (envEnd >= 0) {
      rest = system.slice(envEnd + "</env>".length).replace(V2_DATE_PREFIX, "");
      const codeModeAt = rest.indexOf(V2_CODE_MODE);
      if (codeModeAt >= 0) {
        const keepAt = V2_KEEP_MARKERS.map((m) => rest.indexOf(m))
          .filter((i) => i > codeModeAt)
          .sort((a, b) => a - b)[0];
        rest = keepAt === undefined ? "" : rest.slice(keepAt);
      }
      rest = rest.trim();
    }
    // No </env> after "# Your Model": unrecognized V2 layout — forward
    // nothing rather than risk the third-party credential rejection.
    return formatContext(head, rest);
  }

  const envAt = system.indexOf(ENV_MARKER);
  let head = envAt >= 0 ? system.slice(0, envAt).trim() : "";
  let rest = envAt >= 0 ? system.slice(envAt) : system;
  if (STOCK_BASE_PROMPT.test(head)) head = "";
  const envEnd = rest.indexOf("</env>");
  if (envAt >= 0 && envEnd >= 0) rest = rest.slice(envEnd + "</env>".length);
  else if (STOCK_BASE_PROMPT.test(rest)) rest = "";
  rest = rest.trim();

  return formatContext(head, rest);
}

/** Rules for a turn whose tools are bridged OpenCode tools. */
function bridgedToolRules(toolNames: string[]): string {
  const rules = [
    "You are running inside OpenCode. Built-in Claude Code tools are disabled. Use only the mcp__opencode__* tools provided for this turn; they execute via OpenCode.",
    "Batch independent tool calls into a single turn instead of calling them one at a time.",
  ];
  if (toolNames.includes("todowrite")) {
    rules.push(
      "For any multi-step work, ALWAYS write the plan with the mcp__opencode__todowrite tool and keep it updated as you progress. A plan that only exists in your text is lost when the session is restored or handed to another agent.",
    );
  }
  if (toolNames.includes("execute")) {
    rules.push(
      "Code mode: mcp__opencode__execute({ code }) runs JavaScript in OpenCode's confined runtime — prefer it over many direct mcp__opencode__* calls when several tool operations must be chained or batched into one result. Inside `code` the mcp__opencode__* tools are not visible; call host tools as tools.<path>(input) and discover exact paths and signatures with the synchronous search({ query }) function before using them. `fetch` is available; imports, filesystem access and timers are not. Await every call whose result you use (Promise.all for independent calls) and return the composed result explicitly.",
    );
  }
  return rules.join(" ");
}

export type ClaudeCodePreset = {
  type: "preset";
  preset: "claude_code";
  append?: string;
};

/**
 * System prompt of a turn: always the Claude Code preset, with the meta
 * instructions, the bridged-tool rules and the forwarded OpenCode context
 * appended as they apply. `bridgedToolNames` is null when the turn runs
 * without bridged tools.
 */
export function claudeCodePreset(
  metaKind: MetaRequestKind,
  messages: MessageLike[],
  bridgedToolNames: string[] | null,
): ClaudeCodePreset {
  const preset: ClaudeCodePreset = { type: "preset", preset: "claude_code" };
  if (metaKind) {
    preset.append = metaPresetAppend(metaKind, messages);
    return preset;
  }
  const context = systemContextForwardingEnabled()
    ? openCodeSystemContext(messages)
    : "";
  const append = [
    bridgedToolNames ? bridgedToolRules(bridgedToolNames) : "",
    context,
  ]
    .filter(Boolean)
    .join("\n\n");
  if (append) preset.append = append;
  return preset;
}
