import { MCP_DESCRIPTION_LIMIT } from "./auth-env.js";

/**
 * Claude Code truncates MCP tool descriptions at this many characters: the
 * limit the child env sets, or the user's own override.
 * OpenCode appends the list of subagents to the END of its task tool
 * description, after the guidance, so a cut there hides which subagent_type
 * values exist. Past the limit, move the list to the front: the cut then
 * falls on the tail of the generic guidance instead.
 */
export const CLAUDE_TOOL_DESCRIPTION_LIMIT =
  Number.parseInt(process.env.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH ?? "", 10) || MCP_DESCRIPTION_LIMIT;

const AGENT_LIST_MARKER =
  "Available agent types and the tools they have access to:";

export function fitToolDescription(description: string): string {
  if (description.length <= CLAUDE_TOOL_DESCRIPTION_LIMIT) return description;
  const at = description.indexOf(AGENT_LIST_MARKER);
  if (at <= 0) return description;
  const agents = description.slice(at).trim();
  const guidance = description.slice(0, at).trim();
  return guidance ? `${agents}\n\n${guidance}` : agents;
}
