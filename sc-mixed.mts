// Cheap diagnostic: which of the three `mixed` sub-questions is dragging the
// 53%? Baseline only (self-correct is killed), same 10 real-NYC scenes, per-QUESTION.
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
  questionIds: ["enclosure", "road_misplacement", "nearest_offstreet"],
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
const byQ: Record<string, { n: number; ok: number }> = {};
for (const it of items) {
  (byQ[it.questionId] ??= { n: 0, ok: 0 }).n++;
  if (it.correct) byQ[it.questionId].ok++;
}
console.log("\nquestion             n   correct   acc");
for (const [q, r] of Object.entries(byQ)) {
  console.log(`${q.padEnd(20)} ${String(r.n).padStart(2)}   ${String(r.ok).padStart(3)}     ${((100 * r.ok) / r.n).toFixed(0)}%`);
}
fs.writeFileSync("results-mixed.json", JSON.stringify(byQ, null, 2));
console.log("\nwrote results-mixed.json");
