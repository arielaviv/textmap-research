/**
 * Batch driver for the spatial-representation eval.
 *
 * Plain Node + fetch (no app imports), so it runs anywhere. It POSTs to the
 * /api/experiments/repr-eval/run endpoint (which holds the engine + API key) and
 * writes results.csv + report.md.
 *
 * Prereq: the Next app must be running (dev or deployed) with ANTHROPIC_API_KEY
 * (and NEXT_PUBLIC_MAPBOX_TOKEN for the image arm) set in its environment.
 *
 * Usage:
 *   node experiments/spatial-repr-eval/run-eval.mjs --url http://localhost:3000 --n 5
 *   node experiments/spatial-repr-eval/run-eval.mjs --url http://localhost:3000 --n 30 \
 *        --models claude-sonnet-4-6,claude-opus-4-8 --repeats 1
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const url = arg("url", "http://localhost:3000").replace(/\/$/, "");
const smoke = process.argv.includes("--smoke");
const n = Number(arg("n", smoke ? "5" : "30"));
const models = arg("models", "claude-sonnet-4-6")
  .split(",")
  .map((s) => s.trim());
const arms = arg("arms", "json,ascii,textmap,image,verdict")
  .split(",")
  .map((s) => s.trim());
const repeats = Number(arg("repeats", "1"));
const temperature = Number(arg("temp", "0"));
const seed = Number(arg("seed", "1000"));
const sourceMode = arg("source", "synthetic"); // "synthetic" | "real"
const city = arg("city", "nyc");
const isolate = arg("isolate", "false") === "true"; // representation-only arms (no JSON baseline)

const outDir = arg("out", dirname(fileURLToPath(import.meta.url)));

function pct(x) {
  return `${(x * 100).toFixed(1)}%`;
}

// Rough client-side estimate; the server recomputes the exact count (config.totalCalls).
const QUESTION_COUNT = 9;

async function main() {
  const calls = n * models.length * arms.length * QUESTION_COUNT * repeats;
  console.log(`Running eval → ${url}`);
  console.log(
    `  scenes=${n} models=${models.join(",")} arms=${arms.join(",")} repeats=${repeats} temp=${temperature}`,
  );
  console.log(`  ~${calls} model calls (estimate)\n`);

  const resp = await fetch(`${url}/api/experiments/repr-eval/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: sourceMode, city, n, models, arms, repeats, temperature, seed, isolate }),
  });
  if (!resp.ok) {
    console.error(`Request failed: ${resp.status} ${await resp.text()}`);
    process.exit(1);
  }
  const data = await resp.json();
  const { items, aggregate } = data;
  if (data.config?.totalCalls) console.log(`  server ran ${data.config.totalCalls} calls\n`);

  // --- results.csv ---
  const header =
    "sceneId,model,arm,questionId,category,repeat,correct,inputTokens,outputTokens,error";
  const rows = items.map((r) =>
    [
      r.sceneId,
      r.model,
      r.arm,
      r.questionId,
      r.category,
      r.repeat,
      r.correct,
      r.inputTokens,
      r.outputTokens,
      JSON.stringify(r.error ?? ""),
    ].join(","),
  );
  const csvPath = join(outDir, "results.csv");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(csvPath, [header, ...rows].join("\n"), "utf8");

  // --- report.md ---
  const lines = [];
  lines.push("# Spatial-Representation Eval — Results\n");
  lines.push(`Config: ${JSON.stringify(data.config)}\n`);
  lines.push(`Total items: ${aggregate.totalItems} (errors: ${aggregate.errors})\n`);

  lines.push("\n## Accuracy by arm (95% Wilson CI)\n");
  lines.push("| Arm | Accuracy | 95% CI | n | avg in-tok | avg out-tok |");
  lines.push("|-----|----------|--------|---|-----------|------------|");
  for (const a of aggregate.perArm) {
    lines.push(
      `| ${a.arm} | ${pct(a.acc)} | [${pct(a.lo)}, ${pct(a.hi)}] | ${a.n} | ${a.avgInputTokens} | ${a.avgOutputTokens} |`,
    );
  }

  lines.push("\n## Accuracy by arm × category\n");
  lines.push("| Arm | Category | Accuracy | 95% CI | n |");
  lines.push("|-----|----------|----------|--------|---|");
  for (const a of aggregate.perArmCategory) {
    lines.push(
      `| ${a.arm} | ${a.category} | ${pct(a.acc)} | [${pct(a.lo)}, ${pct(a.hi)}] | ${a.n} |`,
    );
  }

  lines.push("\n## Pairwise comparison (McNemar, paired)\n");
  lines.push("| Arm A | Arm B | acc A | acc B | b | c | χ² | p |");
  lines.push("|-------|-------|-------|-------|---|---|----|---|");
  for (const p of aggregate.pairwise) {
    lines.push(
      `| ${p.armA} | ${p.armB} | ${pct(p.accA)} | ${pct(p.accB)} | ${p.mcnemar.b} | ${p.mcnemar.c} | ${p.mcnemar.statistic.toFixed(2)} | ${p.mcnemar.p.toFixed(4)} |`,
    );
  }
  lines.push(
    "\n_b = A correct & B wrong; c = A wrong & B correct. p<0.05 ⇒ the arms differ significantly._\n",
  );

  const mdPath = join(outDir, "report.md");
  writeFileSync(mdPath, lines.join("\n"), "utf8");

  // --- console summary ---
  console.log("Accuracy by arm:");
  for (const a of aggregate.perArm) {
    console.log(
      `  ${a.arm.padEnd(8)} ${pct(a.acc).padStart(6)}  [${pct(a.lo)}, ${pct(a.hi)}]  (n=${a.n})`,
    );
  }
  console.log(`\nWrote ${csvPath}`);
  console.log(`Wrote ${mdPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
