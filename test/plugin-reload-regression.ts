/**
 * OpenCode reloads a plugin by unloading its copy and importing a fresh one
 * (dist rebuilt, package.json written, idle location torn down). The old
 * copy's unload stopped every parked turn: the CLI recorded the pending tool
 * calls as rejected by the user and Claude stopped mid-command. Turns now
 * live in the process, so the fresh copy resumes a turn the old one parked;
 * the last instance of any copy stops them only after a grace period.
 * Ported from upstream 1.3.5.
 */
import { cpSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROXY_TOKEN_HEADER, SESSION_HEADER } from "../src/constants.ts";
import { assert, bashTool, callTool, interruptibleTurn, result, textDelta, user } from "./helpers.ts";

const repo = join(import.meta.dir, "..");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A separate copy of the plugin's modules, as OpenCode loads on reload. */
async function loadCopy(root: string, name: string) {
  const dir = join(root, name);
  cpSync(join(repo, "src"), join(dir, "src"), { recursive: true });
  symlinkSync(join(repo, "node_modules"), join(dir, "node_modules"));
  const { setAuthStatusProbe } = await import(join(dir, "src", "detect.ts"));
  setAuthStatusProbe(async () => ({ detail: "auth-status-oauth" }));
  return (await import(join(dir, "src", "proxy.ts"))) as typeof import("../src/proxy.ts");
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), "opencode-claude-reload-"));
  process.env.XDG_DATA_HOME = tmp;
  process.env.CLAUDE_CONFIG_DIR = join(tmp, "claude");
  process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE = join(tmp, "rate-limit.json");
  process.env.OPENCODE_CLAUDE_STOP_GRACE_MS = "50";
  process.env.OPENCODE_CLAUDE_RELOAD_GRACE_MS = "300";
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const oldCopy = await loadCopy(tmp, "old");
    const newCopy = await loadCopy(tmp, "new");
    assert.notEqual(oldCopy, newCopy, "two module copies");
    const post = (copy: typeof oldCopy, port: number, body: Record<string, unknown>) =>
      fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [PROXY_TOKEN_HEADER]: copy.getProxyAuthToken(),
          [SESSION_HEADER]: "reload",
        },
        body: JSON.stringify({ model: "sonnet", stream: false, tools: [bashTool], ...body }),
      });

    const log: string[] = [];
    oldCopy.setClaudeQueryStarter(async (params) => {
      log.push("turn:spawn");
      return interruptibleTurn({ log, name: "turn", sessionId: "reload-sess", body: async function* () {
        yield { type: "system", subtype: "init", session_id: "reload-sess" };
        const output = await callTool(params) as { content: Array<{ text: string }> };
        yield textDelta(`done: ${output.content.map((c) => c.text).join("")}`);
        yield { ...result, session_id: "reload-sess" };
      } });
    });
    newCopy.setClaudeQueryStarter(async () => {
      log.push("new:spawn");
      throw new Error("the reloaded copy must resume the parked turn, not start one");
    });

    const oldPort = await oldCopy.acquireProxy();
    const messages = [user("run the long command")];
    const first = await (await post(oldCopy, oldPort, { messages })).json() as any;
    assert.equal(first.choices[0].finish_reason, "tool_calls");
    const call = first.choices[0].message.tool_calls[0];

    // OpenCode's order: the old copy unloads, then the fresh one loads.
    await oldCopy.releaseProxy();
    await sleep(100);
    const newPort = await newCopy.acquireProxy();
    assert.notEqual(newPort, oldPort);
    await sleep(500);
    assert.ok(!log.includes("turn:interrupt"), "unloading the old copy left the parked turn alone");

    const resumed = await (await post(newCopy, newPort, {
      messages: [...messages, { role: "assistant", content: null, tool_calls: [call] },
        { role: "tool", tool_call_id: call.id, content: "finished" }],
    })).json() as any;
    assert.equal(resumed.choices[0].finish_reason, "stop", JSON.stringify(resumed));
    assert.match(resumed.choices[0].message.content, /done: finished/);
    assert.ok(!log.includes("new:spawn"), "resumed, not rebuilt");

    // The last instance going away still stops what is left, after the grace.
    newCopy.setClaudeQueryStarter(async (params) => interruptibleTurn({
      log, name: "late", sessionId: "reload-sess", body: async function* () {
        yield { type: "system", subtype: "init", session_id: "reload-sess" };
        callTool(params).catch(() => {});
        await new Promise(() => {});
      },
    }));
    const late = await (await post(newCopy, newPort, { messages: [user("again")] })).json() as any;
    assert.equal(late.choices[0].finish_reason, "tool_calls");
    await newCopy.releaseProxy();
    assert.ok(!log.includes("late:interrupt"), "a reload's grace period first");
    await sleep(600);
    assert.ok(log.includes("late:interrupt"), "the last release stops parked turns after the grace period");
  } finally {
    clearInterval(keepAlive);
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log("ok — plugin reload regression passed");
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
