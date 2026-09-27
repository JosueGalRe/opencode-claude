/** The CLI registers parallel MCP calls after message_stop, not during it. */
import assert from "node:assert/strict";
import { TurnRunner } from "../src/turn-runner.ts";

async function main() {
  const runner = new TurnRunner({ bridgeId: "parallel-test", conversationKey: "parallel-test" });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const call = (id: string) => ({
    id, name: "read", arguments: "{}", resolve: () => {}, reject: () => {},
  });
  const stream = (async function* () {
    yield { type: "stream_event", event: { type: "message_start" } };
    for (const _ of [0, 1]) {
      yield { type: "stream_event", event: {
        type: "content_block_start", content_block: { type: "tool_use", name: "mcp__opencode__read" },
      } };
    }
    yield { type: "stream_event", event: { type: "message_stop" } };
    runner.pendingTools.set("a", call("a"));
    runner.notifyPark();
    await Bun.sleep(5);
    runner.pendingTools.set("b", call("b"));
    runner.notifyPark();
    await blocked;
  })();
  runner.attach({ stream, close: release });
  const started = performance.now();
  let parked = false;
  for await (const event of runner.events()) {
    if (event && typeof event === "object" && "type" in event && event.type === "__park__") {
      parked = true;
      assert.equal(event.tools.length, 2, "both calls reach OpenCode in one step");
      assert.ok(performance.now() - started < 2_000, "no three-second quiet wait");
    }
  }
  assert.equal(parked, true);
  release();
  console.log("ok — parallel tools regression passed");
}

main().catch((error) => { console.error(error); process.exit(1); });
