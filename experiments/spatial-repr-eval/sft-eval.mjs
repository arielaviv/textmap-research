/**
 * SFT benchmark eval — standalone (no dev-server engine, no chain conflicts).
 *
 * Composes prompts EXACTLY as training did (same system, same user layout,
 * hints included — sft-generate.mjs is the source of the format), asks the
 * model via Together, parses the trailing "ANSWER: {json}", grades locally
 * with the SAME oracle/graders as every other run. Scenes come from the
 * sft-scene endpoint (CPU-only on the dev server — safe alongside chains).
 *
 * Usage:
 *   TOGETHER_API_KEY=... pnpm exec tsx experiments/spatial-repr-eval/sft-eval.mjs \
 *     --model "ari_8ff0/...-textmap-v25-725f3f60" --out results/sft-v1 \
 *     --url http://localhost:3377 --n 20 --seed 2000 --source real --city nyc \
 *     [--questions holdout] [--concurrency 8]
 */

import { mkdirSync, writeFileSync } from "node:fs";

const geo = await import("./core/geo.ts");
const oracle = await import("./core/oracle.ts");
const questions = await import("./core/questions.ts");
const { toTextMapV2 } = await import("./core/textmap.ts");
const { hintFor } = await import("./core/hints.ts");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const url = arg("url", "http://localhost:3377").replace(/\/$/, "");
const MODEL = arg("model", "");
const OUT = arg("out", "results/sft-eval");
const N = Number(arg("n", "20"));
const SEED = Number(arg("seed", "2000"));
const SOURCE = arg("source", "real");
const CITY = arg("city", "nyc");
const QSET = arg("questions", "core"); // core | holdout
const CONC = Number(arg("concurrency", "8"));
// Any OpenAI-compatible host (Together default; HF Inference Endpoints via
// --api-base https://<id>.endpoints.huggingface.cloud + --key-env HF_TOKEN).
const API_BASE = arg("api-base", "https://api.together.xyz").replace(/\/$/, "");
const KEY = process.env[arg("key-env", "TOGETHER_API_KEY")];
if (!MODEL || !KEY) {
  console.error("need --model and an API key in the env named by --key-env");
  process.exit(1);
}

// ── EXACT training composition (mirror of sft-generate.mjs) ────────────────
const SYSTEM =
  "You are a precise spatial-analysis assistant for GIS / FTTH network data. " +
  "You are given a representation of a small map (buildings, streets, equipment, cables) and ONE question. " +
  "First write an EXTRACTION: section listing the facts relevant to the question, exactly as they appear in the representation. " +
  "Then output your final line as: ANSWER: {json object with ONLY the requested field(s)}. " +
  "Ids must match exactly the ids present in the data. Do not invent ids.";

function toJSON(scene) {
  const buildings = scene.buildings.map((b) => ({
    id: b.id,
    type: b.type,
    floors: b.floors,
    position: b.centroid,
    coordinates: [b.footprint],
    address: b.address,
  }));
  const streets = scene.streets.map((s) => ({ id: s.id, name: s.name, coordinates: s.coordinates }));
  const equipment = {
    type: "FeatureCollection",
    features: scene.equipment.map((e) => ({
      type: "Feature",
      id: e.id,
      geometry: { type: "Point", coordinates: e.position },
      properties: { kind: e.kind, serves: e.serves },
    })),
  };
  const cables = {
    type: "FeatureCollection",
    features: scene.cables.map((c) => ({
      type: "Feature",
      id: c.id,
      geometry: { type: "LineString", coordinates: c.path },
      properties: { kind: c.kind, source: c.sourceId, target: c.targetId },
    })),
  };
  return [
    "=== buildings.json ===",
    JSON.stringify(buildings),
    "=== streets.json ===",
    JSON.stringify(streets),
    "=== layers/equipment.geojson ===",
    JSON.stringify(equipment),
    "=== layers/cables.geojson ===",
    JSON.stringify(cables),
  ].join("\n");
}

async function fetchScene(seed) {
  const r = await fetch(`${url}/api/experiments/repr-eval/sft-scene`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ seed, source: SOURCE, city: CITY }),
  });
  if (!r.ok) throw new Error(`sft-scene ${r.status}`);
  return (await r.json()).scene;
}

async function ask(user) {
  const t0 = Date.now();
  const r = await fetch(`${API_BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      max_tokens: 1500,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: user },
      ],
      stream: false,
    }),
  });
  const latencyMs = Date.now() - t0;
  if (!r.ok) return { error: `${r.status}: ${(await r.text()).slice(0, 120)}`, latencyMs };
  const data = await r.json();
  return {
    text: data.choices?.[0]?.message?.content ?? "",
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
    latencyMs,
  };
}

function lastJson(text) {
  const m = text.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g);
  if (!m) return null;
  for (let i = m.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(m[i]);
    } catch {
      /* keep scanning */
    }
  }
  return null;
}

// string→[string] / numeric coercion, mirroring core/model.ts coerceAnswer
function coerce(a) {
  if (!a || typeof a !== "object") return a;
  for (const k of ["equipmentIds", "cableIds", "buildingIds", "equipmentPath"]) {
    if (typeof a[k] === "string") a[k] = a[k] === "none" || a[k] === "" ? [] : [a[k]];
  }
  if (typeof a.count === "string") a.count = Number(a.count);
  if (typeof a.onStreet === "string") a.onStreet = a.onStreet.toLowerCase() === "true";
  return a;
}

async function main() {
  const QS = QSET === "holdout" ? questions.HOLDOUT_QUESTIONS : questions.QUESTIONS;
  const scenes = [];
  for (let i = 0; i < N; i++) {
    try {
      scenes.push(await fetchScene(SEED + i));
    } catch (e) {
      console.error(`skip seed ${SEED + i}: ${e.message}`);
    }
  }
  console.log(`${scenes.length} scenes; ${QS.length} questions; arms textmap2+json; model ${MODEL}`);

  const tasks = [];
  for (const scene of scenes) {
    const reps = { textmap2: toTextMapV2(scene, { zoom: 1 }), json: toJSON(scene) };
    for (const q of QS) {
      for (const arm of ["textmap2", "json"]) {
        tasks.push({ scene, q, arm, user: `${reps[arm]}\n\nQUESTION:\n${q.prompt(scene)}${hintFor(q.id, arm)}` });
      }
    }
  }

  const rows = [];
  let done = 0;
  async function worker() {
    for (;;) {
      const t = tasks.shift();
      if (!t) return;
      const res = await ask(t.user);
      let correct = false;
      let parsed = null;
      if (res.text) {
        parsed = coerce(lastJson(res.text));
        if (parsed) {
          try {
            correct = t.q.grade(t.scene, parsed);
          } catch {
            /* malformed costs its item */
          }
        }
      }
      rows.push({
        sceneId: t.scene.id,
        arm: t.arm,
        questionId: t.q.id,
        correct,
        inputTokens: res.inputTokens ?? 0,
        outputTokens: res.outputTokens ?? 0,
        latencyMs: res.latencyMs,
        answer: JSON.stringify(parsed ?? null),
        error: res.error ?? "",
      });
      done++;
      if (done % 40 === 0) console.log(`${done}/${rows.length + tasks.length}`);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));

  mkdirSync(OUT, { recursive: true });
  const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  writeFileSync(
    `${OUT}/results.csv`,
    [
      "sceneId,arm,questionId,correct,inputTokens,outputTokens,latencyMs,answer,error",
      ...rows.map((r) =>
        [r.sceneId, r.arm, r.questionId, r.correct, r.inputTokens, r.outputTokens, r.latencyMs, esc(r.answer), esc(r.error)].join(","),
      ),
    ].join("\n"),
    "utf8",
  );

  for (const arm of ["textmap2", "json"]) {
    const a = rows.filter((r) => r.arm === arm);
    const ok = a.filter((r) => r.correct).length;
    const errs = a.filter((r) => r.error).length;
    console.log(`${arm}: ${((100 * ok) / a.length).toFixed(1)}% (${ok}/${a.length}, errors ${errs})`);
  }
  console.log(`wrote ${OUT}/results.csv`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
