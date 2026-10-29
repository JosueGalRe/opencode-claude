/**
 * Fast mode (#62): OpenCode has no speed setting, so a model the CLI says
 * supports fast mode gets a second picker entry, "<name> Fast". Picking it
 * runs the turn with the SDK's `fastMode` setting; the plain entry does not.
 *
 * Run: bun test/fast-mode-regression.ts
 */
import { assert, startMockedProxy, textDelta } from "./helpers.ts";

async function main() {
  const keepAlive = setInterval(() => {}, 1000);
  const { post, proxy } = await startMockedProxy("fast-mode");
  const { modelsFromSdk, setDiscoveredModels, resolveClaudeModelId, isFastModelId } = await import("../src/models.ts");
  try {
    const models = modelsFromSdk([
      { value: "default", resolvedModel: "claude-opus-5-5", supportsFastMode: true },
      { value: "claude-opus-5-5", resolvedModel: "claude-opus-5-5", supportedEffortLevels: ["low", "high"], supportsFastMode: true },
      { value: "sonnet", resolvedModel: "claude-sonnet-5-5" },
    ]);
    assert.deepEqual(
      models.map((m) => [m.id, m.name]),
      [
        ["claude-opus-5-5", "Opus 5.5"],
        ["claude-opus-5-5:fast", "Opus 5.5 Fast"],
        ["claude-sonnet-5-5", "Sonnet 5.5"],
      ],
    );
    const fast = models[1]!;
    assert.equal(fast.contextWindow, 1_000_000);
    assert.deepEqual(fast.efforts, ["low", "high"], "keeps the model's effort variants");
    setDiscoveredModels(models);
    assert.equal(resolveClaudeModelId("claude-opus-5-5:fast"), "claude-opus-5-5");
    assert.equal(isFastModelId("claude-opus-5-5:fast"), true);
    assert.equal(isFastModelId("claude-opus-5-5"), false);

    const seen: Array<{ model: string; fastMode: unknown }> = [];
    proxy.setClaudeQueryStarter(async (params: any) => {
      seen.push({ model: params.model, fastMode: params.fastMode });
      return {
        stream: (async function* () {
          yield { type: "system", subtype: "init", session_id: `fast-${seen.length}` };
          yield textDelta("ok");
          yield { type: "result", is_error: false, usage: {} };
        })(),
        interrupt: async () => {},
        close: () => {},
        getPid: () => null,
      };
    });
    for (const [session, model] of [["fast", "claude-opus-5-5:fast"], ["plain", "claude-opus-5-5"]]) {
      const res = await post(session!, { model, messages: [{ role: "user", content: "hi" }] });
      assert.equal(res.status, 200);
    }
    assert.deepEqual(seen, [
      { model: "claude-opus-5-5", fastMode: true },
      { model: "claude-opus-5-5", fastMode: false },
    ]);
    console.log("fast-mode regression ok");
  } finally {
    clearInterval(keepAlive);
    await proxy.stopProxy?.();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
