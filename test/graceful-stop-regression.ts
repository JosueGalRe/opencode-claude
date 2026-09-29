/** Interrupt/settle/close ordering, bounded failure, and serialized spawns. */
import { clearAllBridges, deleteBridgesByConversation, putBridge, stopBridge, stopConversationBridges } from "../src/bridge-pool.ts";
import { withGracefulStop } from "../src/query.ts";
import { assert, bashTool, callTool, interruptibleTurn, result, startMockedProxy, textDelta, user } from "./helpers.ts";

async function main() {
  const h = await startMockedProxy("graceful-stop");
  process.env.OPENCODE_CLAUDE_STOP_GRACE_MS = "1000";
  try {
    // Given a pending stream read, stop must observe each interruption event once.
    {
      const log: string[] = [];
      const observed: unknown[] = [];
      const handle = withGracefulStop(interruptibleTurn({ log, name: "a", body: async function* () {
        yield { type: "system" };
        await new Promise(() => {});
      } }));
      handle.onEvent((event) => observed.push(event));
      const it = handle.stream[Symbol.asyncIterator]();
      await it.next();
      const pending = it.next();
      await Promise.all([handle.stop(), handle.stop(), pending]);
      assert.deepEqual(log, ["a:interrupt", "a:close"]);
      assert.deepEqual(observed.map((event) => event && typeof event === "object" && "type" in event ? event.type : null),
        ["system", "user", "user", "result"]);
    }
    // An unresponsive or already-dead CLI cannot hold the next turn forever.
    for (const fails of [false, true]) {
      const log: string[] = [];
      const handle = withGracefulStop({
        stream: (async function* () { await new Promise(() => {}); })(),
        interrupt: async () => { log.push("interrupt"); if (fails) throw new Error("exited"); },
        close: () => { log.push("close"); },
      });
      const pending = handle.stream[Symbol.asyncIterator]().next();
      await handle.stop(10);
      assert.deepEqual(log, ["interrupt", "close"]);
      assert.equal((await pending).done, true, "force close unblocks active consumer");
    }
    // Late events from a forced-closed handle cannot overwrite a new binding.
    {
      const late = Promise.withResolvers<IteratorResult<unknown>>();
      const events: unknown[] = [];
      const handle = withGracefulStop({
        stream: { [Symbol.asyncIterator]: () => ({ next: () => late.promise }) },
        interrupt: async () => {}, close() {},
      });
      handle.onEvent((event) => events.push(event));
      await handle.stop(1);
      late.resolve({ done: false, value: { type: "user", uuid: "stale" } });
      await late.promise;
      assert.deepEqual(events, []);
    }
    // Shutdown waits even when a background stop already removed the bridge.
    {
      const log: string[] = [];
      const settle = Promise.withResolvers<void>();
      const handle = interruptibleTurn({ log, name: "shutdown", settle: settle.promise,
        body: async function* () { await new Promise(() => {}); } });
      putBridge({ id: "shutdown", conversationKey: "shutdown", handle,
        pendingTools: new Map(), seenAssistantUsageIds: new Set(), resume: async function* () {} });
      const stopping = stopBridge("shutdown");
      await handle.interrupted;
      const shutdown = clearAllBridges();
      assert.deepEqual(log, ["shutdown:interrupt"]);
      settle.resolve();
      await shutdown;
      assert.deepEqual(log, ["shutdown:interrupt", "shutdown:close"]);
      await stopping;
    }
    // Stops outside the pool are still awaited; tool rejection follows interrupt.
    {
      const log: string[] = [];
      const settle = Promise.withResolvers<void>();
      const toolDone = Promise.withResolvers<void>();
      let interrupted: Promise<unknown> = Promise.resolve();
      h.proxy.setClaudeQueryStarter(async (params) => {
        log.push("p1:spawn");
        const turn = interruptibleTurn({ log, name: "p1", settle: settle.promise, body: async function* () {
          yield { type: "system" };
          void callTool(params).then(() => { log.push("tool:rejected"); toolDone.resolve(); });
          await new Promise(() => {});
        } });
        interrupted = turn.interrupted;
        return turn;
      });
      const first = await h.post("parked", { tools: [bashTool], messages: [user("run")] });
      await first.text();
      deleteBridgesByConversation("parked");
      await interrupted;
      h.proxy.setClaudeQueryStarter(async () => {
        log.push("p2:spawn");
        return interruptibleTurn({ log, name: "p2", body: async function* () { yield textDelta("next"); yield result; } });
      });
      const next = h.post("parked", { messages: [user("run"), user("next")] });
      assert.deepEqual(log, ["p1:spawn", "p1:interrupt"]);
      settle.resolve();
      await (await next).text();
      await toolDone.promise;
      assert.ok(log.indexOf("p1:close") < log.indexOf("p2:spawn"));
      assert.ok(log.indexOf("p1:interrupt") < log.indexOf("tool:rejected"));
    }
    // Concurrent HTTP starts serialize through asynchronous query construction.
    {
      const log: string[] = [];
      const entered = Promise.withResolvers<void>();
      const constructed = Promise.withResolvers<void>();
      let turn = 0;
      h.proxy.setClaudeQueryStarter(async () => {
        const name = `c${++turn}`;
        log.push(`${name}:spawn`);
        if (name === "c1") { entered.resolve(); await constructed.promise; }
        return interruptibleTurn({ log, name, body: async function* () {
          yield textDelta(name);
          if (name === "c1") await new Promise(() => {});
          yield result;
        } });
      });
      const a = h.post("race", { messages: [user("one")] });
      await entered.promise;
      const b = h.post("race", { messages: [user("one"), user("two")] });
      constructed.resolve();
      await Promise.all([a.then((r) => r.text()), b.then((r) => r.text())]);
      assert.deepEqual(log.slice(0, 4), ["c1:spawn", "c1:interrupt", "c1:close", "c2:spawn"]);
    }
    // Failure before publication must release the spawn lock for retries.
    h.proxy.setClaudeQueryStarter(async () => { throw new Error("spawn failed"); });
    assert.equal((await h.post("retry", { messages: [user("one")] })).status, 500);
    h.proxy.setClaudeQueryStarter(async () => interruptibleTurn({ log: [], name: "retry", body: async function* () { yield textDelta("ok"); yield result; } }));
    assert.equal((await h.post("retry", { messages: [user("one")] })).status, 200);
    await stopConversationBridges("retry");
  } finally {
    await h.cleanup();
  }
  console.log("ok — graceful stop regression passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
