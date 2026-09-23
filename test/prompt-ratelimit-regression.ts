/**
 * Regressions for prompt conversion, meta-request classification and the
 * rate-limit gate:
 * - a limit error after an unrelated `allowed` window event blocks only for
 *   the short fallback, never until that window's (days-away) reset;
 * - hours-only ("resets 5pm (UTC)") and midnight reset times parse;
 * - PDFs in tool results are forwarded, URL media leaves a note;
 * - only the newest real user message becomes the prompt;
 * - an oversized newest history entry is truncated, not dropped;
 * - forwarded AGENTS.md wording / quoted history cannot make a turn meta.
 *
 * Run: bun test/prompt-ratelimit-regression.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildConversationTranscript,
  latestUserPrompt,
  openaiToolResultToMcpContent,
  SYNTHETIC_TOOL_MEDIA_PROMPT,
} from "../src/prompt.ts";
import {
  isClaudeRateLimitText,
  parseResetTimeFromText,
  recordRateLimitErrorText,
  recordRateLimitInfo,
} from "../src/rate-limit.ts";
import { detectMetaRequestKind } from "../src/request-kind.ts";

const MINUTE = 60_000;

async function main() {
  // The store path is resolved per call, so setting it here isolates the run.
  const tmp = mkdtempSync(join(tmpdir(), "opencode-claude-prompt-rl-"));
  process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE = join(tmp, "rate-limit.json");

  try {
    // --- Rate limit: unrelated window reset never becomes the block deadline
    const nowSec = Math.floor(Date.now() / 1000);
    recordRateLimitInfo({
      status: "allowed",
      rateLimitType: "seven_day",
      resetsAt: nowSec + 5 * 24 * 3600,
    });
    const before = Date.now();
    const blocked = recordRateLimitErrorText(
      "API Error: 429 rate limit exceeded, please retry",
    );
    assert.ok(blocked?.limited, "limit text must still block");
    assert.ok(
      blocked!.limitedUntil! <= Date.now() + 10 * MINUTE,
      `block must not extend to the seven_day reset: ${new Date(blocked!.limitedUntil!).toISOString()}`,
    );
    assert.ok(blocked!.limitedUntil! >= before + 9 * MINUTE);

    // A recent `rejected` event does vouch for its reset.
    rmSync(process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE!, { force: true });
    const rejectedReset = nowSec + 3 * 3600;
    recordRateLimitInfo({
      status: "rejected",
      rateLimitType: "five_hour",
      resetsAt: rejectedReset,
    });
    const hard = recordRateLimitErrorText("You've hit your session limit");
    assert.equal(hard!.limitedUntil, rejectedReset * 1000);

    // A bare HTTP status is not a limit message.
    assert.equal(isClaudeRateLimitText("API Error: 429 Internal hiccup"), false);
    assert.equal(recordRateLimitErrorText("upstream returned 429"), null);
    assert.equal(
      isClaudeRateLimitText("You've hit your weekly limit · resets Oct 6, 1pm (UTC)"),
      true,
    );

    // --- Reset parsing: hours-only and midnight (every 5-minute scan phase)
    const base = Date.UTC(2026, 0, 1, 10, 0);
    const fivePm = parseResetTimeFromText("You've hit your session limit · resets 5pm (UTC)", base);
    assert.ok(fivePm !== undefined, "hours-only reset must parse");
    assert.ok(Math.abs(fivePm! - Date.UTC(2026, 0, 1, 17, 0)) <= 2 * MINUTE);
    const midnight = Date.UTC(2026, 0, 2, 0, 0);
    for (let phase = 0; phase < 5; phase++) {
      const now = Date.UTC(2026, 0, 1, 20, phase);
      for (const text of ["resets 12am (UTC)", "resets 12:00am (UTC)"]) {
        const parsed = parseResetTimeFromText(text, now);
        assert.ok(parsed !== undefined, `${text} missed at phase ${phase}`);
        assert.ok(Math.abs(parsed! - midnight) <= 2 * MINUTE, `${text} phase ${phase}`);
      }
    }

    // --- Tool results: PDFs forwarded, URL media noted, never dropped
    const toolResult = openaiToolResultToMcpContent([
      { type: "text", text: "Read report.pdf" },
      {
        type: "file",
        file: { filename: "report.pdf", file_data: "data:application/pdf;base64,JVBERi0xLjQ=" },
      },
      { type: "image_url", image_url: { url: "https://example.com/chart.png" } },
    ]);
    const pdf = toolResult.find((b) => b.type === "resource");
    assert.ok(pdf && pdf.type === "resource", "PDF must be forwarded");
    assert.equal(pdf.resource.mimeType, "application/pdf");
    assert.equal(pdf.resource.blob, "JVBERi0xLjQ=");
    assert.ok(
      toolResult.some(
        (b) => b.type === "text" && b.text.includes("https://example.com/chart.png"),
      ),
      "URL image must leave a note",
    );

    // --- Prompt: newest real user message only
    assert.equal(
      latestUserPrompt([
        { role: "user", content: "OLD-QUESTION" },
        { role: "assistant", content: "answered" },
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "file:///tmp/shot.png" } }],
        },
      ]).toString().includes("OLD-QUESTION"),
      false,
      "must not fall back to an answered user message",
    );
    const unrelayable = latestUserPrompt([
      { role: "user", content: "OLD-QUESTION" },
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "file:///tmp/shot.png" } }],
      },
    ]);
    assert.equal(typeof unrelayable, "string");
    assert.match(unrelayable as string, /could not be relayed/);
    assert.equal(
      latestUserPrompt([
        { role: "user", content: "REAL-ASK" },
        { role: "assistant", content: "Reading the screenshot." },
        { role: "tool", content: "done" },
        {
          role: "user",
          content: [
            { type: "text", text: SYNTHETIC_TOOL_MEDIA_PROMPT },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          ],
        },
      ]),
      "REAL-ASK",
      "synthetic tool-media message is not a user turn",
    );

    // --- Transcript: oversized newest entry truncated, budget respected
    const huge = `NEWEST-HEAD ${"x".repeat(5000)} NEWEST-TAIL`;
    const transcript = buildConversationTranscript(
      [
        { role: "user", content: "older question" },
        { role: "assistant", content: "older answer" },
        { role: "user", content: huge },
      ],
      1000,
    );
    assert.ok(transcript.length <= 1000, `budget exceeded: ${transcript.length}`);
    assert.match(transcript, /NEWEST-HEAD/);
    assert.match(transcript, /NEWEST-TAIL/);
    assert.match(transcript, /chars omitted/);
    assert.match(transcript, /2 earlier message\(s\) omitted/);
    const fits = buildConversationTranscript(
      [
        { role: "user", content: "a".repeat(40) },
        { role: "assistant", content: "b".repeat(40) },
        { role: "user", content: "c".repeat(40) },
      ],
      120,
    );
    assert.ok(fits.length <= 120, `separators/header must count: ${fits.length}`);

    // --- Meta classification: anchored to the system prompt's opening line
    // and to the newest user message.
    assert.equal(
      detectMetaRequestKind([
        {
          role: "system",
          content:
            "You are opencode, an interactive CLI coding agent.\n\nInstructions from: /repo/AGENTS.md\nThe session title generator must never see secrets. Write like a pull request description when summarizing PRs.",
        },
        { role: "user", content: "Fix the flaky test" },
      ]),
      null,
      "AGENTS.md wording must not make a normal turn meta",
    );
    assert.equal(
      detectMetaRequestKind([
        { role: "system", content: "You are opencode, an interactive CLI coding agent." },
        { role: "user", content: "What does <previous-summary> do in this file?" },
        { role: "assistant", content: "It wraps the prior summary." },
        { role: "user", content: "Thanks, now rename it." },
      ]),
      null,
      "an earlier user message must not make later turns meta",
    );
    assert.equal(
      detectMetaRequestKind([
        {
          role: "system",
          content:
            "You are a title generator. You output ONLY a thread title. Nothing else.\n\n<task>\nGenerate a brief title",
        },
        { role: "user", content: "Explain quicksort" },
      ]),
      "title",
    );
    assert.equal(
      detectMetaRequestKind([
        {
          role: "system",
          content:
            "You are a context summarization agent. You are given a conversation between a user and an agent.",
        },
        { role: "user", content: "Summarize." },
      ]),
      "summary",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log("ok — prompt/rate-limit regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
