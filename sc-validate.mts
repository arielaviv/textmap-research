// Full-pipeline validation after the Tier 0-2 improvements: haiku, all 10
// questions, real-NYC, hints + scan + citations + zoom + rings + feeds +
// worldFacts + routed executor (incl. the new reducer ops). Reports per-category
// + per-mixed-question + composite, vs the pre-improvement 75.5-class baseline.
import fs from "node:fs";
import { fetchRealOSM } from "./app/api/experiments/repr-eval/osm-fetch";
import { type EvalConfig, type ItemResult, runEval } from "./experiments/spatial-repr-eval/core/engine";
import { buildRealScene } from "./experiments/spatial-repr-eval/core/real-scene";
import type { Scene } from "./experiments/spatial-repr-eval/core/scene";

if (!process.env.ANTHROPIC_API_KEY && fs.existsSync(".env.local")) {
  for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^\s*ANTHROPIC_API_KEY\s*=\s*(.+?)\s*$/);
    if (m) process.env.ANTHROPIC_API_KEY = m[1].replace(/^["']|["']$/g, "");
  }
}
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

const ROTATE = [{}, { closureInBuilding: true }, { cableCrossing: true }, { coverageGap: true }];
const scenes: Scene[] = [];
for (let i = 0; i < 10; i++) {
  try {
    const { buildings, streets } = await fetchRealOSM("nyc", 2000 + i, 350);
    scenes.push(
      buildRealScene({
        id: `scene-${i}`,
        buildings,
        streets,
        maxBuildings: 12,
        plant: { ...ROTATE[i % ROTATE.length], closureOnStreet: true },
      }),
    );
  } catch {
    /* skip */
  }
}
console.log(`built ${scenes.length} real-NYC scenes`);

const config: EvalConfig = {
  apiKey,
  models: ["claude-haiku-4-5-20251001"],
  arms: ["textmap2"],
  scenes,
  temperature: 0,
  repeats: 1,
  concurrency: 3,
  isolate: true,
  questionIds: undefined, // all 10 questions
  hints: true,
  votes: 1,
  turns: 1,
  scan: true,
  scanTargets: true,
  tools: true,
  toolsRouted: true,
  selfCorrect: false,
  extents: false,
  rings: true,
  feeds: true,
  worldFacts: true,
  citations: true,
  zoom: 2,
  fewshot: false,
};

const items: ItemResult[] = (await runEval(config)).items;

const byCat: Record<string, { n: number; ok: number }> = {};
const byQ: Record<string, { n: number; ok: number }> = {};
let tin = 0;
let tout = 0;
for (const it of items) {
  (byCat[it.category] ??= { n: 0, ok: 0 }).n++;
  if (it.correct) byCat[it.category].ok++;
  (byQ[it.questionId] ??= { n: 0, ok: 0 }).n++;
  if (it.correct) byQ[it.questionId].ok++;
  tin += it.inputTokens;
  tout += it.outputTokens;
}
const total = items.length;
const ok = items.filter((x) => x.correct).length;

console.log("\n=== per category ===");
for (const [c, r] of Object.entries(byCat)) console.log(`${c.padEnd(18)} ${((100 * r.ok) / r.n).toFixed(0)}%  (${r.ok}/${r.n})`);
console.log("\n=== per question (mixed detail) ===");
for (const [q, r] of Object.entries(byQ)) console.log(`${q.padEnd(20)} ${((100 * r.ok) / r.n).toFixed(0)}%  (${r.ok}/${r.n})`);
console.log(`\nCOMPOSITE  ${((100 * ok) / total).toFixed(1)}%   (${ok}/${total})   tokens in ${tin} out ${tout}`);

fs.writeFileSync("results-validate.json", JSON.stringify({ byCat, byQ, composite: (100 * ok) / total, tin, tout }, null, 2));
console.log("wrote results-validate.json");
