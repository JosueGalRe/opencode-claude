/**
 * Detect OpenCode meta-requests (session title, compaction/summary) that must
 * not run as a full Claude Code agent turn.
 */
import { extractTextContent } from "./prompt.js";

export type MetaRequestKind = "title" | "summary" | null;

type MessageLike = {
  role?: string;
  content?: unknown;
};

// OpenCode v1.18.25+ update-summary envelope: <conversation> + <prior-summary>
// with (possibly) intervening prose before the <template> instruction. A bare
// <prior-summary> mention in an ordinary prompt must NOT match.
const OPENCODE_UPDATE_SUMMARY_PATTERN =
  /here is the conversation so far:\s*<conversation>[\s\S]*?<\/conversation>\s*here is the summary of the conversation before the <conversation> above:\s*<prior-summary>[\s\S]*?<\/prior-summary>\s*the <prior-summary> summarizes everything that happened before the <conversation>\. construct a new summary that combines both\.[\s\S]*?output exactly the markdown structure shown inside <template>/;

export function metaSystemPrompt(messages: MessageLike[]): string {
  return messages
    .filter((m) => m.role === "system")
    .map((m) => extractTextContent(m.content))
    .join("\n");
}

/**
 * True when the opening line of any system message names one of `phrases`.
 * OpenCode's meta agents (title, summary, compaction) announce their role
 * in that first line; the rest of the system prompt carries forwarded
 * AGENTS.md / instructions / MCP notes whose wording must never turn a
 * normal turn into a meta request.
 */
function systemOpensWith(messages: MessageLike[], phrases: string[]): boolean {
  return messages.some((m) => {
    if (m.role !== "system") return false;
    const text = extractTextContent(m.content).trimStart();
    const end = text.indexOf("\n");
    const opening = (end === -1 ? text : text.slice(0, end)).toLowerCase();
    return phrases.some((phrase) => opening.includes(phrase));
  });
}

/** Newest user message only — earlier turns may quote meta prompts. */
function latestUserText(messages: MessageLike[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      return extractTextContent(messages[i].content).toLowerCase();
    }
  }
  return "";
}

export function isTitleGenerationRequest(messages: MessageLike[]): boolean {
  return systemOpensWith(messages, [
    "title generator",
    "generate a short title",
    "generate a brief title",
    "output only a thread title",
  ]);
}

export function isSummaryGenerationRequest(messages: MessageLike[]): boolean {
  if (
    systemOpensWith(messages, [
      "context summarization agent",
      "anchored context summarization",
      "summarizing, compacting, or merging context",
      "tasked with summarizing conversations",
      "write like a pull request description",
      "summarize what was done in this conversation",
    ])
  ) {
    return true;
  }

  const user = latestUserText(messages);
  return (
    OPENCODE_UPDATE_SUMMARY_PATTERN.test(user) ||
    user.includes(
      "this summary will be the only context available when the conversation continues",
    ) ||
    user.includes(
      "create a detailed summary for continuing this coding session",
    ) ||
    user.includes("anchored summary from the conversation history") ||
    user.includes("anchored summary below using the conversation history") ||
    user.includes("<previous-summary>")
  );
}

export function detectMetaRequestKind(
  messages: MessageLike[],
): MetaRequestKind {
  if (isTitleGenerationRequest(messages)) return "title";
  if (isSummaryGenerationRequest(messages)) return "summary";
  return null;
}

/** Namespace so meta requests never collide with live agent session state. */
export function requestKeyNamespace(kind: MetaRequestKind): string {
  if (kind === "title") return "title:";
  if (kind === "summary") return "summary:";
  return "";
}
