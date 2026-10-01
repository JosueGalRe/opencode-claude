import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  metaInstructions,
  metaSystemPrompt,
  type MetaRequestKind,
} from "./request-kind.js";

type MessageLike = { role?: string; content?: unknown };

const ENV_MARKER = "You are powered by the model named";
const STOCK_BASE_PROMPT =
  /^You are (OpenCode|opencode|an AI agent running in OpenCode)\b/;
// OpenCode V2 assembles: agent prompt, "# Your Model", one block of
// instruction sources, then plugin additions. 2.0.15 rendered <env> and
// "Today's date" before "# Code Mode" and user configuration; 2.0.19+ renders
// Code Mode, MCP notes, references, skills and "Instructions from: …" first,
// then the date and <env>, and sends later changes ("Today's date is now",
// "The environment … is now") as extra system messages. So the stock
// sections are stripped wherever they sit. V1 has no "# Your Model".
const V2_MODEL_MARKER = /^# Your Model$/m;
const V2_MODEL_BLOCK = /^# Your Model\n(?:- [^\n]*(?:\n|$))*/m;
const V2_ENV_BLOCK =
  /(?:^[^\n]*environment you are running in[^\n]*\n)?<env>[\s\S]*?<\/env>/gm;
const V2_DATE_LINE = /^Today's date(?: is now)?:[^\n]*$/gm;

/**
 * V2's Code Mode catalog: its heading through the tool listing under
 * "## Available tools". OpenCode renders the listing as one block (tool
 * signatures may span lines), so a blank line or a heading ends it; what
 * follows (date, environment, skills) need not have a heading.
 */
function v2CodeMode(v2Body: string): string {
  const heading = /^# Code Mode[\t ]*\r?$/m.exec(v2Body);
  if (!heading) return "";
  const rest = v2Body.slice(heading.index);
  const tools = /^## Available tools[\t ]*\r?$/m.exec(rest);
  if (!tools) return "";
  const afterTools = tools.index + tools[0].length;
  const listAt = afterTools + (/^(?:[\t ]*\r?\n)+/.exec(rest.slice(afterTools))?.[0].length ?? 0);
  const list = rest.slice(listAt);
  if (!list.startsWith("- ")) return "";
  const end = /\r?\n[\t ]*\r?\n|\r?\n#{1,6} /.exec(list);
  return rest.slice(0, listAt + (end ? end.index : list.length)).trim();
}

/**
 * Instruction files Claude Code loads itself with this proxy's setting
 * sources (user, project, local): ~/.claude/CLAUDE.md and, in the working
 * directory and each parent, CLAUDE.md, CLAUDE.local.md, .claude/CLAUDE.md,
 * and AGENTS.md (2.1.28x reads it where there is no CLAUDE.md; where both
 * exist, CLAUDE.md is Claude's own and the choice is Claude Code's).
 */
function claudeCodeInstructionFiles(cwd: string): string[] {
  const files = [join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "CLAUDE.md")];
  for (let dir = realPath(cwd); ; dir = dirname(dir)) {
    for (const name of ["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md", "AGENTS.md", ".claude/AGENTS.md"]) {
      files.push(join(dir, name));
    }
    if (dirname(dir) === dir) return files;
  }
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Drop "Instructions from: <path>" blocks Claude Code already loads (the
 * same file, through a symlink too, or the same text), so their rules don't
 * arrive twice. A block is cut only where its text still matches the file;
 * anything else is forwarded.
 */
function withoutClaudeCodeInstructions(rest: string, cwd: string): string {
  if (!rest.includes("Instructions from: ")) return rest;
  const own = claudeCodeInstructionFiles(cwd);
  const ownPaths = new Set(own.map(realPath));
  const ownTexts = new Set(own.map((file) => readText(file)?.trim()).filter(Boolean));
  let out = rest;
  for (const [header, path] of rest.matchAll(/^Instructions from: (.+?)[\t ]*$/gm)) {
    const text = readText(path!)?.trim();
    if (!text || !(ownPaths.has(realPath(path!)) || ownTexts.has(text))) continue;
    const at = out.indexOf(`${header}\n`);
    const bodyAt = at < 0 ? -1 : out.indexOf(text, at + header.length);
    if (bodyAt < 0 || out.slice(at + header.length, bodyAt).trim()) continue;
    out = out.slice(0, at) + out.slice(bodyAt + text.length);
  }
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

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
 * apps…"). Its Code Mode catalog is forwarded separately only when the
 * `execute` tool is bridged.
 *
 * With `cwd`, instruction files Claude Code loads itself for that directory
 * are left out.
 */
export function openCodeSystemContext(messages: MessageLike[], cwd?: string): string {
  const system = metaSystemPrompt(messages).trim();
  if (!system) return "";
  const own = (rest: string) => cwd ? withoutClaudeCodeInstructions(rest, cwd) : rest;

  const v2ModelAt = system.search(V2_MODEL_MARKER);
  if (v2ModelAt >= 0) {
    let head = system.slice(0, v2ModelAt).trim();
    if (STOCK_BASE_PROMPT.test(head)) head = "";
    const body = system.slice(v2ModelAt);
    // No </env> after "# Your Model": unrecognized V2 layout — forward
    // nothing rather than risk the third-party credential rejection.
    if (!body.includes("</env>")) return formatContext(head, "");
    const rest = body
      .replace(v2CodeMode(body), "")
      .replace(V2_MODEL_BLOCK, "")
      .replace(V2_ENV_BLOCK, "")
      .replace(V2_DATE_LINE, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return formatContext(head, own(rest));
  }

  const envAt = system.indexOf(ENV_MARKER);
  let head = envAt >= 0 ? system.slice(0, envAt).trim() : "";
  let rest = envAt >= 0 ? system.slice(envAt) : system;
  if (STOCK_BASE_PROMPT.test(head)) head = "";
  const envEnd = rest.indexOf("</env>");
  if (envAt >= 0 && envEnd >= 0) rest = rest.slice(envEnd + "</env>".length);
  else if (STOCK_BASE_PROMPT.test(rest)) rest = "";
  rest = rest.trim();

  return formatContext(head, own(rest));
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
      "mcp__opencode__execute({ code }) runs JavaScript in OpenCode's confined runtime. Inside `code`, call host tools as tools.<path>(input) and discover exact signatures with search({ query }); `fetch` works, but imports, filesystem access and timers do not. Await calls and return the result.",
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
 * Meta turns need none of Claude Code's coding instructions. A non-preset
 * system prompt is accepted on subscription credentials (checked on Haiku 4.5
 * and Opus 5.5), and this one is 2-6k tokens smaller than the preset.
 */
const UTILITY_SYSTEM_PROMPT =
  "You are a text generation helper running through the Claude Code harness. Return only the requested output.";

/**
 * System prompt of a turn. Meta turns: the one-line utility prompt with
 * their instructions. Other turns: the Claude Code preset, with the
 * bridged-tool rules and the forwarded OpenCode context appended as they
 * apply. `bridgedToolNames` is null when the turn runs without bridged tools;
 * `cwd` is where Claude Code runs, whose instruction files it loads itself.
 */
export function turnSystemPrompt(
  metaKind: MetaRequestKind,
  messages: MessageLike[],
  bridgedToolNames: string[] | null,
  cwd?: string,
): ClaudeCodePreset | string {
  if (metaKind) {
    // V2 sends its summary instructions in the user turn; its system prompt is
    // the agent's own, whose "# Your Model"/<env> sections get the request
    // rejected as third-party usage.
    const system = metaSystemPrompt(messages);
    return [
      UTILITY_SYSTEM_PROMPT,
      metaInstructions(metaKind, V2_MODEL_MARKER.test(system) ? "" : system),
    ].join("\n\n");
  }
  const preset: ClaudeCodePreset = { type: "preset", preset: "claude_code" };
  const forwardContext = systemContextForwardingEnabled();
  const context = forwardContext
    ? openCodeSystemContext(messages, cwd)
    : "";
  const system = metaSystemPrompt(messages);
  const modelAt = system.search(V2_MODEL_MARKER);
  const codeMode =
    forwardContext && bridgedToolNames?.includes("execute") &&
    modelAt >= 0 && system.includes("</env>", modelAt)
      ? v2CodeMode(system.slice(modelAt))
      : "";
  const append = [
    bridgedToolNames ? bridgedToolRules(bridgedToolNames) : "",
    codeMode ? `${codeMode}\n\nThe \`execute\` tool above is mcp__opencode__execute.` : "",
    context,
  ]
    .filter(Boolean)
    .join("\n\n");
  if (append) preset.append = append;
  return preset;
}
