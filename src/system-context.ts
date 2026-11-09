import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
  metaInstructions,
  metaSystemPrompt,
  type MetaRequestKind,
} from "./request-kind.js";

type MessageLike = { role?: string; content?: unknown };

const ENV_MARKER = "You are powered by the model named";
const STOCK_BASE_PROMPT =
  /^You are (OpenCode|opencode|an AI agent running in OpenCode)\b/;

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

/** Claude Code follows `@path` imports up to four hops deep. */
const IMPORT_DEPTH = 4;
/** An `@path` import: at the start of a line or after whitespace; `\ ` keeps a space. */
const IMPORT = /(?<=^|\s)@((?:\\ |\S)+)/g;

/** Files `text` imports: `~/` is the home directory, relative paths are from `file`. Not in code. */
function importsOf(file: string, text: string): string[] {
  const prose = text.replace(/```[\s\S]*?(?:```|$)/g, "").replace(/`[^`\n]*`/g, "");
  return [...prose.matchAll(IMPORT)].map((match) => {
    let target = match[1]!.replace(/\\ /g, " ");
    if (target === "~" || target.startsWith("~/")) target = join(homedir(), target.slice(1));
    return isAbsolute(target) ? target : join(dirname(file), target);
  });
}

/** `files` plus what their `@path` imports pull in, as Claude Code expands them. */
function withImports(files: string[]): string[] {
  const out = [...files];
  const seen = new Set(files.map(realPath));
  const walk = (file: string, depth: number) => {
    if (depth > IMPORT_DEPTH) return;
    const text = readText(file);
    if (!text) return;
    for (const target of importsOf(file, text)) {
      const real = realPath(target);
      if (seen.has(real)) continue;
      seen.add(real);
      out.push(target);
      walk(target, depth + 1);
    }
  };
  for (const file of files) walk(file, 1);
  return out;
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
 * same file, through a symlink or an `@path` import too, or the same text),
 * so their rules don't arrive twice. A block is cut only where its text
 * still matches the file; anything else is forwarded.
 */
function withoutClaudeCodeInstructions(rest: string, cwd: string): string {
  if (!rest.includes("Instructions from: ")) return rest;
  const own = withImports(claudeCodeInstructionFiles(cwd));
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
 * (#6). Recover those from V1's system prompt so they can be appended to the
 * preset. OpenCode's stock base prompt and its <env> block are skipped;
 * Claude Code supplies its own equivalents. V2 is read by structure instead
 * (`systemContextFromParts`).
 *
 * With `cwd`, instruction files Claude Code loads itself for that directory
 * are left out.
 */
export function openCodeSystemContext(messages: MessageLike[], cwd?: string): string {
  const system = metaSystemPrompt(messages).trim();
  if (!system) return "";
  const own = (rest: string) => cwd ? withoutClaudeCodeInstructions(rest, cwd) : rest;

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

type SystemPartLike = { text: string; metadata?: Record<string, unknown> };

/** Instruction sources Claude Code writes itself. */
const CLAUDE_SUPPLIED_SOURCES = new Set(["core/date", "core/environment"]);
/**
 * The part V2's identity plugin inserts: "# Your Model" and its "- " lines,
 * nothing else. Built-in hooks run before ours, so it is already there.
 */
const V2_MODEL_PART = /^# Your Model\n(?:- [^\n]*(?:\n|$))*$/;

function instructionSources(part: SystemPartLike): Array<{ key: string; text: string }> | undefined {
  const experimental = part.metadata?.experimental as { instructions?: unknown } | undefined;
  const sources = experimental?.instructions;
  return Array.isArray(sources) &&
    sources.every((s) => typeof s?.key === "string" && typeof s?.text === "string")
    ? sources
    : undefined;
}

/** OpenCode ≥ 2.2.3 keys each instruction source; older V2 sends plain text. */
export function hasInstructionSources(parts: SystemPartLike[]): boolean {
  return parts.some((part) => instructionSources(part) !== undefined);
}

/**
 * V2 system parts read by structure instead of wording: part 0 is the
 * agent's prompt, which the preset replaces (`role`, a custom agent's own
 * prompt, is forwarded instead), the instructions part lists its sources by
 * key, and plugins add parts of their own. Returns what is appended to the
 * preset, the Code Mode catalog first when `execute` is offered.
 */
export function systemContextFromParts(
  parts: SystemPartLike[],
  role: string,
  toolNames: string[],
  cwd: string,
): string {
  let codeMode = "";
  const texts: string[] = [];
  for (const part of parts.slice(1)) {
    const sources = instructionSources(part);
    if (!sources) {
      if (!V2_MODEL_PART.test(part.text.trim())) texts.push(part.text);
      continue;
    }
    for (const source of sources) {
      if (CLAUDE_SUPPLIED_SOURCES.has(source.key)) continue;
      if (source.key === "core/codemode") codeMode = source.text.trim();
      else texts.push(source.text);
    }
  }
  const context = withoutClaudeCodeInstructions(texts.join("\n\n").trim(), cwd);
  return [
    codeMode && toolNames.includes("execute")
      ? `${codeMode}\n\nThe \`execute\` tool above is mcp__opencode__execute.`
      : "",
    formatContext(role.trim(), context),
  ]
    .filter(Boolean)
    .join("\n\n");
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
  excludeDynamicSections?: boolean;
};

/**
 * Claude Code puts the working directory, memory path and git status into its
 * system prompt, so no two sessions share it and every new session (each
 * subagent too) writes the whole prompt to the cache again. Without them the
 * prompt is the same everywhere and a new session reads it from the cache;
 * Claude Code passes them in the first user message instead.
 * OPENCODE_CLAUDE_DYNAMIC_SECTIONS=keep restores the old layout.
 */
function excludeDynamicSections(): boolean {
  return (process.env.OPENCODE_CLAUDE_DYNAMIC_SECTIONS ?? "").trim().toLowerCase() !== "keep";
}

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
 * `prepared`: V2's hooks already reduced the system prompt to what Claude
 * gets (`systemContextFromParts`).
 */
export function turnSystemPrompt(
  metaKind: MetaRequestKind,
  messages: MessageLike[],
  bridgedToolNames: string[] | null,
  cwd?: string,
  prepared = false,
): ClaudeCodePreset | string {
  if (metaKind) {
    // V2 sends its summary instructions in the user turn; its system prompt is
    // the agent's own context. V1 summary agents carry theirs in the system
    // prompt.
    return [
      UTILITY_SYSTEM_PROMPT,
      metaInstructions(metaKind, prepared ? "" : metaSystemPrompt(messages)),
    ].join("\n\n");
  }
  // Part of the chat turn's remembered prompt, so a summary that resumes the
  // chat repeats it and still reads from the cache.
  const preset: ClaudeCodePreset = {
    type: "preset",
    preset: "claude_code",
    ...(excludeDynamicSections() ? { excludeDynamicSections: true } : {}),
  };
  const forwardContext = systemContextForwardingEnabled();
  const context = !forwardContext
    ? ""
    : prepared
      ? metaSystemPrompt(messages).trim()
      : openCodeSystemContext(messages, cwd);
  const append = [
    bridgedToolNames ? bridgedToolRules(bridgedToolNames) : "",
    context,
  ]
    .filter(Boolean)
    .join("\n\n");
  if (append) preset.append = append;
  return preset;
}
