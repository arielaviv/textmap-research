// Paired A/B: does the executor-verified self-correct loop lift the laggard
// categories? Same 10 real-NYC scenes for both arms; only `selfCorrect` differs.
import fs from "node:fs";
import { fetchRealOSM } from "./app/api/experiments/repr-eval/osm-fetch";
import { type EvalConfig, type ItemResult, runEval } from "./experiments/spatial-repr-eval/core/engine";
import { buildRealScene } from "./experiments/spatial-repr-eval/core/real-scene";
import type { Scene } from "./experiments/spatial-repr-eval/core/scene";

// plain tsx doesn't auto-load .env.local (that's a Next feature) — load it here.
if (!process.env.ANTHROPIC_API_KEY && fs.existsSync(".env.local")) {
  for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^\s*ANTHROPIC_API_KEY\s*=\s*(.+?)\s*$/);
    if (m) process.env.ANTHROPIC_API_KEY = m[1].replace(/^["']|["']$/g, "");
  }
}
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

const ROTATE = [{}, { closureInBuilding: true }, { cableCrossing: true }, { coverageGap: true }];
const QIDS = ["crossing", "blockage", "enclosure", "road_misplacement", "nearest_offstreet", "topology"];

// Build the SAME 10 scenes both arms will see (seed 2000+i, ~350m AOI).
const scenes: Scene[] = [];
for (let i = 0; i < 10; i++) {
  try {
    const { buildings, streets } = await fetchRealOSM("nyc", 2000 + i, 350);
    const plant = { ...ROTATE[i % ROTATE.length], closureOnStreet: true };
    scenes.push(buildRealScene({ id: `scene-${i}`, buildings, streets, maxBuildings: 12, plant }));
  } catch {
    /* AOI on water/park — skip */
  }
}
console.log(`built ${scenes.length} real-NYC scenes`);

function cfg(selfCorrect: boolean): EvalConfig {
  return {
    apiKey: apiKey as string,
    models: ["claude-haiku-4-5-20251001"],
    arms: ["textmap2"],
    scenes,
    temperature: 0,
    repeats: 1,
    concurrency: 5,
    isolate: true,
    questionIds: QIDS,
    hints: true,
    votes: 1,
    turns: 4, // same answer-loop budget both arms; only selfCorrect differs
    scan: true,
    scanTargets: true,
    tools: true,
    toolsRouted: true,
    selfCorrect,
    extents: false,
    rings: true,
    feeds: true,
    citations: true,
    zoom: 2,
    fewshot: false,
  };
}

function breakdown(items: ItemResult[]) {
  const byCat: Record<string, { n: number; ok: number }> = {};
  let tin = 0;
  let tout = 0;
  for (const it of items) {
    (byCat[it.category] ??= { n: 0, ok: 0 }).n++;
    if (it.correct) byCat[it.category].ok++;
    tin += it.inputTokens;
    tout += it.outputTokens;
  }
  const total = items.length;
  const ok = items.filter((x) => x.correct).length;
  return { byCat, pct: total ? (100 * ok) / total : 0, tin, tout, total };
}

console.log("=== BASELINE (no self-correct) ===");
const base = breakdown((await runEval(cfg(false))).items);
console.log(`baseline composite ${base.pct.toFixed(1)}  (in ${base.tin} out ${base.tout} tok)`);

console.log("=== +SELF-CORRECT ===");
const loop = breakdown((await runEval(cfg(true))).items);
console.log(`self-correct composite ${loop.pct.toFixed(1)}  (in ${loop.tin} out ${loop.tout} tok)`);

const cats = [...new Set([...Object.keys(base.byCat), ...Object.keys(loop.byCat)])];
console.log("\ncategory        baseline   +loop   delta");
for (const c of cats) {
  const b = base.byCat[c] ?? { n: 0, ok: 0 };
  const l = loop.byCat[c] ?? { n: 0, ok: 0 };
  const bp = b.n ? (100 * b.ok) / b.n : 0;
  const lp = l.n ? (100 * l.ok) / l.n : 0;
  console.log(
    `${c.padEnd(16)} ${bp.toFixed(0).padStart(5)}%  ${lp.toFixed(0).padStart(5)}%  ${(lp - bp >= 0 ? "+" : "") + (lp - bp).toFixed(0)}`,
  );
}
console.log(`\nCOMPOSITE        ${base.pct.toFixed(1)}%  ${loop.pct.toFixed(1)}%  ${(loop.pct - base.pct >= 0 ? "+" : "") + (loop.pct - base.pct).toFixed(1)}`);

fs.writeFileSync("results-sc.json", JSON.stringify({ base, loop }, null, 2));
console.log("\nwrote results-sc.json");
