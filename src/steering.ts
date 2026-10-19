import {
  extractTextContent,
  SYNTHETIC_TOOL_MEDIA_PROMPT,
  type McpToolResultContent,
} from "./prompt.js";

type MessageLike = { role?: string; content?: unknown };

/**
 * Steering: a user message OpenCode queued while a tool was running arrives
 * after the tool results in the resume request. A parked bridge only
 * consumes tool results, so without this the message was silently dropped
 * (and OpenCode then treats it as answered). Returns the text of each user
 * message that follows the last tool result.
 */
export function collectSteeringText(messages: MessageLike[]): string[] {
  let lastTool = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === "tool") lastTool = i;
  }
  if (lastTool < 0) return [];
  const texts: string[] = [];
  for (const msg of messages.slice(lastTool + 1)) {
    if (msg?.role !== "user") continue;
    const text = extractTextContent(msg.content).trim();
    // OpenCode's promoted-media marker rides the tool result separately;
    // its label text is not a user message.
    if (!text || text === SYNTHETIC_TOOL_MEDIA_PROMPT) continue;
    texts.push(text);
  }
  return texts;
}

function isSystemUpdate(text: string): boolean {
  return text.startsWith("<system-update>") && text.endsWith("</system-update>");
}

/** Append steering text to a tool result so Claude reads it on resume. */
export function withSteering(
  result: McpToolResultContent[],
  steering: string[],
): McpToolResultContent[] {
  // OpenCode sends a changed session context entry as `<system-update>` user
  // text. It comes from the host, not the user, so it is not labelled as theirs.
  const updates = steering.filter(isSystemUpdate);
  const userText = steering.filter((text) => !isSystemUpdate(text)).join("\n\n");
  return [
    ...result,
    ...(updates.length > 0 ? [{ type: "text" as const, text: updates.join("\n\n") }] : []),
    ...(userText
      ? [
          {
            type: "text" as const,
            text: [
              "<system-reminder>",
              "While this tool was running, the user sent the following message(s). Read them now and adjust your current work accordingly; they take priority over earlier instructions where they conflict:",
              "",
              userText,
              "</system-reminder>",
            ].join("\n"),
          },
        ]
      : []),
  ];
}
