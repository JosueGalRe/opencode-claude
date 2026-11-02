/**
 * When a stream breaks partway, Claude Code re-sends the request without
 * streaming. The proxy reads Claude's text only from stream deltas, so that
 * answer's text would never reach OpenCode; the child env turns the fallback
 * off so the failure takes the error path.
 *
 * Run: bun test/nonstreaming-fallback-regression.ts
 */
import assert from "node:assert/strict";
import { buildClaudeCodeChildEnv } from "../src/auth-env.ts";

assert.equal(buildClaudeCodeChildEnv({ PATH: "/bin" }).CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK, "1");
assert.equal(
  buildClaudeCodeChildEnv({ CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: "0" }).CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK,
  "1",
  "an inherited value can't turn the fallback back on",
);

console.log("ok — nonstreaming fallback regression passed");
