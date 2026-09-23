/**
 * Runs the offline suite: smoke.ts plus every *-regression.ts, each in its
 * own process (they set process-wide env and proxy state). Live tests
 * (haiku-live.ts) are excluded — they need a signed-in Claude CLI.
 *
 * Run: bun test/run.ts
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

const dir = import.meta.dir;
const files = [
  "smoke.ts",
  ...readdirSync(dir)
    .filter((name) => name.endsWith("-regression.ts"))
    .sort(),
];

let failed = 0;
for (const file of files) {
  const started = performance.now();
  const proc = Bun.spawn([process.execPath, join(dir, file)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  if (code === 0) {
    console.log(`pass ${file} (${seconds}s)`);
    continue;
  }
  failed++;
  console.log(`FAIL ${file} (exit ${code}, ${seconds}s)`);
  process.stdout.write(stdout);
  process.stderr.write(stderr);
}

console.log(`\n${files.length - failed}/${files.length} test files passed`);
process.exit(failed > 0 ? 1 : 0);
