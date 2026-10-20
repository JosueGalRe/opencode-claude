/**
 * Fast mode: OpenCode has no speed setting, so a model the CLI says supports
 * fast mode gets a second picker entry, "<name> Fast". Picking it runs the
 * chat turn with the SDK's `fastMode` setting on the plain model; the plain
 * entry and titles do not. (Ported from upstream 1.5.0, 9b16372.)
 *
 * Run: bun test/fast-mode-regression.ts
 */
import type { StartClaudeQueryParams } from "../src/query.ts";
import { assert, mockHandle, result, startMockedProxy, textDelta } from "./helpers.ts";

async function main() {
  const h = await startMockedProxy("fast-mode");
  const { modelsFromSdk, setDiscoveredModels, getClaudeModels, resolveClaudeModelId } = await import("../src/models.ts");
  try {
    const models = modelsFromSdk([
      { value: "default", resolvedModel: "claude-opus-5-5", supportsFastMode: true },
      { value: "claude-opus-5-5", resolvedModel: "claude-opus-5-5", supportedEffortLevels: ["low", "high"], supportsFastMode: true },
      { value: "claude-opus-4-8", supportsFastMode: true },
      { value: "sonnet", resolvedModel: "claude-sonnet-5-5" },
    ]);
    assert.deepEqual(models.map((m) => [m.id, m.name]), [
      ["claude-opus-5-5[1m]", "Opus 5.5"],
      ["claude-opus-5-5[1m]:fast", "Opus 5.5 Fast"],
      ["claude-opus-4-8", "Opus 4.8"],
      ["claude-opus-4-8:fast", "Opus 4.8 Fast"],
      ["claude-sonnet-5-5", "Sonnet 5.5"],
    ]);
    const fast = models[1]!;
    assert.equal(fast.contextWindow, 1_000_000);
    assert.deepEqual(fast.efforts, ["low", "high"], "keeps the model's effort variants");
    assert.equal(fast.fast, true);
    assert.equal(models[0]!.fast, undefined);

    // The flag survives the models.json cache.
    setDiscoveredModels(models);
    const cached = Bun.spawnSync({
      cmd: ["bun", "-e", "const { getClaudeModels } = await import('./src/models.ts'); console.log(JSON.stringify(getClaudeModels()))"],
      cwd: `${import.meta.dir}/..`,
      env: { ...process.env },
    });
    assert.equal(cached.exitCode, 0, cached.stderr.toString());
    assert.deepEqual(JSON.parse(cached.stdout.toString()), getClaudeModels());

    assert.equal(resolveClaudeModelId("claude-opus-5-5[1m]:fast"), "claude-opus-5-5[1m]");
    assert.equal(resolveClaudeModelId("claude-opus-5-5[1m]"), "claude-opus-5-5[1m]");

    const seen: Array<{ model?: string; fastMode?: boolean }> = [];
    h.proxy.setClaudeQueryStarter(async (params: StartClaudeQueryParams) => {
      seen.push({ model: params.model, fastMode: params.fastMode });
      return mockHandle((async function* () {
        yield { type: "system", subtype: "init", session_id: `fast-${seen.length}`, fast_mode_state: "off", fast_mode_disabled_reason: "extra_usage_disabled" };
        yield textDelta("ok");
        yield result;
      })());
    });
    for (const [session, model] of [["fast", "claude-opus-5-5[1m]:fast"], ["plain", "claude-opus-5-5[1m]"]] as const) {
      const res = await h.post(session, { model, messages: [{ role: "user", content: "hi" }] });
      assert.equal(res.status, 200);
      await res.text();
    }
    // A title runs at normal speed even when the chat's model is the fast one.
    const title = await h.post("fast-title", { model: "claude-opus-5-5[1m]:fast", messages: [{ role: "user", content: "hi" }] }, { "x-opencode-claude-request-kind": "title" });
    assert.equal(title.status, 200);
    await title.text();
    assert.deepEqual(seen, [
      { model: "claude-opus-5-5[1m]", fastMode: true },
      { model: "claude-opus-5-5[1m]", fastMode: false },
      { model: "claude-opus-5-5[1m]", fastMode: false },
    ]);
  } finally {
    await h.cleanup();
  }
  console.log("ok — fast mode regression passed");
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
