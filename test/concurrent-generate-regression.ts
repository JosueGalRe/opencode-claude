/**
 * Regression: a generate call without a session was keyed by the first 200
 * characters of its prompt, and a new turn stops any other turn with the
 * same key. Concurrent calls sharing an instruction preamble stopped each
 * other ("Claude Code ended the turn without any output"). Each standalone
 * call now gets its own key.
 *
 * Run: bun test/concurrent-generate-regression.ts
 */
import { REQUEST_KIND_HEADER } from "../src/constants.ts";
import { assert, startMockedProxy, textDelta } from "./helpers.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const { post, proxy, cleanup } = await startMockedProxy("concurrent-generate");
  // Like the CLI: a stopped turn ends without output.
  proxy.setClaudeQueryStarter(async () => {
    let stop!: () => void;
    const stopped = new Promise<"stop">((resolve) => (stop = () => resolve("stop")));
    return {
      stream: (async function* () {
        yield { type: "system", subtype: "init", session_id: "gen" };
        if ((await Promise.race([sleep(200), stopped])) === "stop") {
          yield { type: "result", subtype: "error_during_execution", is_error: true, errors: [], session_id: "gen" };
          return;
        }
        yield textDelta("NO");
        yield { type: "result", is_error: false, usage: {}, session_id: "gen" };
      })(),
      interrupt: async () => stop(),
      close: () => stop(),
    };
  });
  try {
    const preamble = "You classify items. Answer with YES or NO only. ".repeat(8);
    const results = await Promise.all(
      [1, 2, 3, 4].map(async (i) => {
        const res = await post("", { messages: [{ role: "user", content: `${preamble}\nItem ${i}: is ${i} even?` }] }, {
          [REQUEST_KIND_HEADER]: "generate",
        });
        return { status: res.status, body: (await res.json()) as any };
      }),
    );
    for (const { status, body } of results) {
      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(body.choices[0].message.content, "NO");
    }
  } finally {
    await cleanup();
  }
  console.log("ok — concurrent generate regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
