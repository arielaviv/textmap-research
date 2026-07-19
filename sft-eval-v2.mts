/**
 * SFT v2 benchmark eval — the 2-call masked-loop counterpart of
 * sft-generate-v2.mts (supersedes experiments/spatial-repr-eval/sft-eval.mjs,
 * kept as the v1 artifact).
 *
 * Mirrors the v2 training contract EXACTLY:
 *  - same SYSTEM, same user-turn assembly (rep + GEO_TOOLS_SPEC for compute
 *    questions + QUESTION + hint), same representation flags
 *    (zoom 1, rings, feeds, worldFacts);
 *  - compute questions run the REAL 2-call loop: call 1 → EXTRACTION +
 *    TOOL_CALLS, the local executor (geo-tools) computes, call 2 gets
 *    TOOL_RESULTS in a user turn and must emit ANSWER — exactly the
 *    conversation shape the masked traces teach;
 *  - read questions are single-call EXTRACTION + ANSWER.
 *
 * Scenes are built DIRECTLY (no dev server): legacy eval lattice seeds via
 * fetchRealOSM — geographically disjoint from every v2 training tile by
 * construction (see sft-generate-v2.mts DEFECT C).
 *
 * --skin <id> runs the vocabulary-invariance test: the user text is rendered
 * in that vocabulary and the parsed answer is reverse-mapped (ids + renamed
 * fields) before grading. Spot-check the reverse map on the first canary run.
 *
 * Usage:
 *   TOGETHER_API_KEY=... pnpm exec tsx sft-eval-v2.mts \
 *     --model "..." --out results/sft-v2-nyc --n 20 --seed 2020 --city nyc \
 *     [--questions core|holdout] [--skin water] [--concurrency 6] \
 *     [--api-base https://api.together.xyz] [--key-env TOGETHER_API_KEY] \
 *     [--api-mode openai|tgi]
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { fetchRealOSM } from "./app/api/experiments/repr-eval/osm-fetch";
import { GEO_TOOLS_SPEC, executeGeoToolLines } from "./experiments/spatial-repr-eval/core/geo-tools";
import { hintFor } from "./experiments/spatial-repr-eval/core/hints";
import { buildRealScene } from "./experiments/spatial-repr-eval/core/real-scene";
import {
  type Answer,
  HOLDOUT_QUESTIONS,
  QUESTIONS,
  type Question,
} from "./experiments/spatial-repr-eval/core/questions";
import type { Scene } from "./experiments/spatial-repr-eval/core/scene";
import { toTextMapV2 } from "./experiments/spatial-repr-eval/core/textmap";

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const MODEL = arg("model", "");
const OUT = arg("out", "results/sft-v2-eval");
const N = Number(arg("n", "20"));
const SEED = Number(arg("seed", "2020"));
const CITY = arg("city", "nyc");
const QSET = arg("questions", "core"); // core | holdout
const SKIN_ID = arg("skin", "ftth");
const CONC = Number(arg("concurrency", "6"));
const API_BASE = arg("api-base", "https://api.together.xyz").replace(/\/$/, "");
const API_MODE = arg("api-mode", "openai"); // openai | tgi
// Token caps — reasoning models (gpt-oss) spend heavily in the analysis
// channel BEFORE the final content; caps must leave room for both, or empty
// finals get graded as wrong (measured: 19/40 empties on base at 1500/6000).
const MT_ANSWER = Number(arg("mt-answer", "1500"));
const MT_TOOLS = Number(arg("mt-tools", "6000"));
const KEY = process.env[arg("key-env", "TOGETHER_API_KEY")];
if (!MODEL || !KEY) {
  console.error("need --model and an API key in the env named by --key-env");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// EXACT training composition (mirror of sft-generate-v2.mts — keep in sync)
// ---------------------------------------------------------------------------
const SYSTEM =
  "You are a precise spatial-analysis assistant for GIS / FTTH network data. " +
  "You are given a representation of a small map (buildings, streets, equipment, cables) and ONE question. " +
  "If the question needs geometric computation, first reply with an EXTRACTION: section (the relevant " +
  "facts and coordinates exactly as they appear in the representation) followed by a TOOL_CALLS: section " +
  "containing ONLY JSON tool lines; you will receive TOOL_RESULTS back, and then you reply with the final " +
  "line ANSWER: {json object with ONLY the requested field(s)}. If no computation is needed, reply " +
  "EXTRACTION: then ANSWER: directly. Ids must match exactly the ids present in the data. Do not invent ids.";

const TOOL_RESULTS_PREFIX =
  "TOOL_RESULTS (computed exactly from the coordinates you supplied — trust these numbers over " +
  "mental arithmetic):";

/** Core question ids that run the 2-call executor loop (the task-bank compute
 *  set restricted to the frozen protocol). */
const COMPUTE_QIDS = new Set([
  "crossing",
  "blockage",
  "enclosure",
  "road_misplacement",
  "nearest_offstreet",
]);

const CROSSING_TOOL_HINT: Record<"textmap2" | "json", string> = {
  textmap2:
    "This is answered by the geometry executor, not by reading grid glyphs. Emit ONE " +
    "segments_cross_polygons call: include EVERY cable from CABLES as a segment (use its m[...] " +
    "meter endpoints), EVERY building's FOOTPRINTS ring, and for each cable set exclude to the " +
    "building it terminates at (its terminates_in=, or the target of source -> target when that " +
    "target is a building; else empty). Your answer = the union of cables the tool reports " +
    "crossing a non-excluded building.",
  json:
    "This is answered by the geometry executor. Emit ONE segments_cross_polygons call: include " +
    "EVERY cable as a segment (its two endpoint coordinates from the data), EVERY building's " +
    "footprint ring, and for each cable set exclude to the building it terminates at (its target " +
    "when that target is a building; else empty). Your answer = the union of cables the tool " +
    "reports crossing a non-excluded building.",
};

function hintText(qid: string, arm: "textmap2" | "json", isCompute: boolean): string {
  if (qid === "crossing" && isCompute) return `\nHINT: ${CROSSING_TOOL_HINT[arm]}`;
  return hintFor(qid, arm);
}

function toJSON(scene: Scene): string {
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

// ---------------------------------------------------------------------------
// skins (forward = render user text; reverse = map parsed answers back).
// Forward rules mirror sft-generate-v2.mts; reverse covers ids + field names
// (the graders only consume ids and field names, never prose).
// ---------------------------------------------------------------------------
type Rule = [RegExp, string];
interface SkinPair {
  id: string;
  forward: Rule[];
  /** applied to parsed answer VALUES (ids) */
  reverseIds: Rule[];
  /** parsed answer KEY renames, skinned → canonical */
  reverseFields: Record<string, string>;
}
const SKIN_PAIRS: SkinPair[] = [
  { id: "ftth", forward: [], reverseIds: [], reverseFields: {} },
  {
    id: "water",
    forward: [
      [/closure/g, "valve"], [/Closure/g, "Valve"], [/CLOSURE/g, "VALVE"],
      [/\bCL-/g, "VL-"],
      [/central office/g, "pumping plant"], [/Central Office/g, "Pumping Plant"],
      [/kind=co\b/g, "kind=plant"], [/"kind":"co"/g, '"kind":"plant"'],
      [/\bCO-(\d+)/g, "PL-$1"], [/\bCO\b/g, "plant"],
      [/kind=drop\b/g, "kind=service"], [/"kind":"drop"/g, '"kind":"service"'],
      [/\bdrop-/g, "svc-"], [/\bdrop\b/g, "service pipe"],
      [/kind=distribution\b/g, "kind=main"], [/"kind":"distribution"/g, '"kind":"main"'],
      [/cable/g, "pipe"], [/Cable/g, "Pipe"], [/CABLES/g, "PIPES"],
      [/FTTH/g, "water utility"],
    ],
    reverseIds: [
      [/\bVL-/g, "CL-"],
      [/\bPL-(\d+)/g, "CO-$1"],
      [/\bsvc-/g, "drop-"],
    ],
    reverseFields: { valveId: "closureId", pipeIds: "cableIds" },
  },
  {
    id: "electric",
    forward: [
      [/closure/g, "transformer"], [/Closure/g, "Transformer"], [/CLOSURE/g, "TRANSFORMER"],
      [/\bCL-/g, "TR-"],
      [/central office/g, "substation"], [/Central Office/g, "Substation"],
      [/kind=co\b/g, "kind=substation"], [/"kind":"co"/g, '"kind":"substation"'],
      [/\bCO-(\d+)/g, "SS-$1"], [/\bCO\b/g, "substation"],
      [/FTTH/g, "electric-grid"],
    ],
    reverseIds: [
      [/\bTR-/g, "CL-"],
      [/\bSS-(\d+)/g, "CO-$1"],
    ],
    reverseFields: { transformerId: "closureId" },
  },
  {
    id: "sensor",
    forward: [
      [/closure/g, "sensor"], [/Closure/g, "Sensor"], [/CLOSURE/g, "SENSOR"],
      [/\bCL-/g, "SN-"],
      [/central office/g, "gateway hub"], [/Central Office/g, "Gateway Hub"],
      [/kind=co\b/g, "kind=gateway"], [/"kind":"co"/g, '"kind":"gateway"'],
      [/\bCO-(\d+)/g, "GW-$1"], [/\bCO\b/g, "gateway"],
      [/FTTH/g, "sensor-network"],
    ],
    reverseIds: [
      [/\bSN-/g, "CL-"],
      [/\bGW-(\d+)/g, "CO-$1"],
    ],
    reverseFields: { sensorId: "closureId" },
  },
  {
    id: "logistics",
    forward: [
      [/closure/g, "depot"], [/Closure/g, "Depot"], [/CLOSURE/g, "DEPOT"],
      [/\bCL-/g, "DP-"],
      [/central office/g, "central hub"], [/Central Office/g, "Central Hub"],
      [/kind=co\b/g, "kind=hub"], [/"kind":"co"/g, '"kind":"hub"'],
      [/\bCO-(\d+)/g, "HB-$1"], [/\bCO\b/g, "hub"],
      [/kind=drop\b/g, "kind=leg"], [/"kind":"drop"/g, '"kind":"leg"'],
      [/\bdrop-/g, "leg-"], [/\bdrop\b/g, "delivery leg"],
      [/cable/g, "route"], [/Cable/g, "Route"], [/CABLES/g, "ROUTES"],
      [/FTTH/g, "logistics"],
    ],
    reverseIds: [
      [/\bDP-/g, "CL-"],
      [/\bHB-(\d+)/g, "CO-$1"],
      [/\bleg-/g, "drop-"],
    ],
    reverseFields: { depotId: "closureId", routeIds: "cableIds" },
  },
  {
    id: "generic",
    forward: [
      [/closure/g, "node"], [/Closure/g, "Node"], [/CLOSURE/g, "NODE"],
      [/\bCL-/g, "ND-"],
      [/central office/g, "root node"], [/Central Office/g, "Root Node"],
      [/kind=co\b/g, "kind=root"], [/"kind":"co"/g, '"kind":"root"'],
      [/\bCO-(\d+)/g, "RT-$1"], [/\bCO\b/g, "root"],
      [/kind=drop\b/g, "kind=spur"], [/"kind":"drop"/g, '"kind":"spur"'],
      [/\bdrop-/g, "spur-"], [/\bdrop\b/g, "spur"],
      [/cable/g, "link"], [/Cable/g, "Link"], [/CABLES/g, "LINKS"],
      [/FTTH/g, "generic network"],
    ],
    reverseIds: [
      [/\bND-/g, "CL-"],
      [/\bRT-(\d+)/g, "CO-$1"],
      [/\bspur-/g, "drop-"],
    ],
    reverseFields: { nodeId: "closureId", linkIds: "cableIds" },
  },
];
const SKIN = SKIN_PAIRS.find((s) => s.id === SKIN_ID);
if (!SKIN) {
  console.error(`unknown --skin '${SKIN_ID}' (valid: ${SKIN_PAIRS.map((s) => s.id).join(", ")})`);
  process.exit(1);
}
const skinFwd = (text: string): string => {
  let out = text;
  for (const [re, repl] of (SKIN as SkinPair).forward) out = out.replace(re, repl);
  return out;
};
const unskinId = (v: string): string => {
  let out = v;
  for (const [re, repl] of (SKIN as SkinPair).reverseIds) out = out.replace(re, repl);
  return out;
};
const unskinAnswer = (a: Record<string, unknown>): Record<string, unknown> => {
  const fields = (SKIN as SkinPair).reverseFields;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a)) {
    const key = fields[k] ?? k;
    if (typeof v === "string") out[key] = unskinId(v);
    else if (Array.isArray(v)) out[key] = v.map((x) => (typeof x === "string" ? unskinId(x) : x));
    else out[key] = v;
  }
  return out;
};

// ---------------------------------------------------------------------------
// provider calls (OpenAI-compatible chat; TGI native with a Llama-3.1 template)
// ---------------------------------------------------------------------------
interface Msg {
  role: "system" | "user" | "assistant";
  content: string;
}
interface AskRes {
  text?: string;
  error?: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

function llamaPrompt(messages: Msg[]): string {
  let p = "<|begin_of_text|>";
  for (const m of messages) {
    p += `<|start_header_id|>${m.role}<|end_header_id|>\n\n${m.content}<|eot_id|>`;
  }
  return `${p}<|start_header_id|>assistant<|end_header_id|>\n\n`;
}

/** One attempt with a hard 240s timeout; askOnce errors surface as AskRes.error. */
async function ask(messages: Msg[], maxTokens: number): Promise<AskRes> {
  // one retry on timeout/transport error — a single hung stream must never
  // stall a worker forever (measured: the first fair-base run wedged on this)
  const first = await askOnce(messages, maxTokens);
  if (first.error && !/^\d{3}:/.test(first.error)) {
    return askOnce(messages, maxTokens);
  }
  return first;
}

async function askOnce(messages: Msg[], maxTokens: number): Promise<AskRes> {
  const t0 = Date.now();
  try {
  if (API_MODE === "tgi") {
    const r = await fetch(`${API_BASE}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        inputs: llamaPrompt(messages),
        parameters: { max_new_tokens: maxTokens, do_sample: false, return_full_text: false },
      }),
      signal: AbortSignal.timeout(240_000),
    });
    const latencyMs = Date.now() - t0;
    if (!r.ok)
      return { error: `${r.status}: ${(await r.text()).slice(0, 120)}`, inputTokens: 0, outputTokens: 0, latencyMs };
    const data = (await r.json()) as { generated_text?: string }[] | { generated_text?: string };
    const text = (Array.isArray(data) ? data[0]?.generated_text : data.generated_text) ?? "";
    return { text, inputTokens: 0, outputTokens: 0, latencyMs };
  }
  const r = await fetch(`${API_BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, temperature: 0, max_tokens: maxTokens, messages, stream: false }),
    signal: AbortSignal.timeout(240_000),
  });
  const latencyMs = Date.now() - t0;
  if (!r.ok)
    return { error: `${r.status}: ${(await r.text()).slice(0, 120)}`, inputTokens: 0, outputTokens: 0, latencyMs };
  const data = (await r.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    text: data.choices?.[0]?.message?.content ?? "",
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
    latencyMs,
  };
  } catch (e) {
    return { error: `transport: ${(e as Error).message.slice(0, 100)}`, inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - t0 };
  }
}

// ---------------------------------------------------------------------------
// answer parsing (trailing ANSWER json; last balanced object wins)
// ---------------------------------------------------------------------------
function lastJson(text: string): Record<string, unknown> | null {
  const m = text.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g);
  if (!m) return null;
  for (let i = m.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(m[i]) as Record<string, unknown>;
    } catch {
      /* keep scanning */
    }
  }
  return null;
}

function coerce(a: Record<string, unknown> | null): Answer | null {
  if (!a || typeof a !== "object") return null;
  const out: Record<string, unknown> = { ...a };
  for (const k of ["equipmentIds", "cableIds", "buildingIds", "equipmentPath"]) {
    if (typeof out[k] === "string") out[k] = out[k] === "none" || out[k] === "" ? [] : [out[k]];
  }
  if (typeof out.count === "string") out.count = Number(out.count);
  if (typeof out.onStreet === "string") out.onStreet = (out.onStreet as string).toLowerCase() === "true";
  return out as Answer;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
const ROTATE = [{}, { closureInBuilding: true }, { cableCrossing: true }, { coverageGap: true }];

interface Row {
  sceneId: string;
  arm: string;
  questionId: string;
  correct: boolean;
  usedTools: boolean;
  toolLinesOk: boolean;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  answer: string;
  error: string;
}

async function main(): Promise<void> {
  const QS: Question[] = QSET === "holdout" ? HOLDOUT_QUESTIONS : QUESTIONS;
  const scenes: Scene[] = [];
  for (let i = 0; i < N; i++) {
    try {
      const { buildings, streets } = await fetchRealOSM(CITY, SEED + i, 350);
      scenes.push(
        buildRealScene({
          id: `ev-${SEED + i}`,
          buildings,
          streets,
          maxBuildings: 12,
          plant: { ...ROTATE[i % ROTATE.length], closureOnStreet: true },
        }),
      );
    } catch (e) {
      console.error(`skip seed ${SEED + i}: ${(e as Error).message}`);
    }
  }
  console.log(
    `${scenes.length} scenes (${CITY}, seeds ${SEED}+); ${QS.length} questions; skin=${SKIN_ID}; model ${MODEL}`,
  );

  interface Task {
    scene: Scene;
    q: Question;
    arm: "textmap2" | "json";
  }
  const tasks: Task[] = [];
  const reps = new Map<string, Record<"textmap2" | "json", string>>();
  for (const scene of scenes) {
    reps.set(scene.id, {
      textmap2: toTextMapV2(scene, { zoom: 1, rings: true, feeds: true, worldFacts: true }),
      json: toJSON(scene),
    });
    for (const q of QS) {
      for (const arm of ["textmap2", "json"] as const) tasks.push({ scene, q, arm });
    }
  }

  const rows: Row[] = [];
  let done = 0;
  const total = tasks.length;

  async function runOne(t: Task): Promise<Row> {
    const isCompute = COMPUTE_QIDS.has(t.q.id);
    const rep = (reps.get(t.scene.id) as Record<"textmap2" | "json", string>)[t.arm];
    const hint = hintText(t.q.id, t.arm, isCompute);
    const userParts = [rep, "", ...(isCompute ? [GEO_TOOLS_SPEC, ""] : []), "QUESTION:", `${t.q.prompt(t.scene)}${hint}`];
    const user1: Msg = { role: "user", content: skinFwd(userParts.join("\n")) };
    const sys: Msg = { role: "system", content: skinFwd(SYSTEM) };

    let inputTokens = 0;
    let outputTokens = 0;
    let latencyMs = 0;
    let usedTools = false;
    let toolLinesOk = false;
    let finalText = "";
    let error = "";

    if (isCompute) {
      const r1 = await ask([sys, user1], MT_TOOLS);
      inputTokens += r1.inputTokens;
      outputTokens += r1.outputTokens;
      latencyMs += r1.latencyMs;
      if (r1.error || !r1.text) {
        error = r1.error ?? "empty call-1";
      } else if (/ANSWER:\s*\{/.test(r1.text) && !/TOOL_CALLS:/.test(r1.text)) {
        // model answered directly without tools — grade what it gave
        finalText = r1.text;
      } else {
        usedTools = true;
        const results = executeGeoToolLines(r1.text);
        toolLinesOk = results !== null;
        const resultsText = results ?? "(no valid tool lines found — answer from the representation)";
        const user2: Msg = {
          role: "user",
          content: skinFwd(`${TOOL_RESULTS_PREFIX}\n${resultsText}\n\nNow give the final answer as the line: ANSWER: {json}`),
        };
        const r2 = await ask([sys, user1, { role: "assistant", content: r1.text }, user2], MT_ANSWER);
        inputTokens += r2.inputTokens;
        outputTokens += r2.outputTokens;
        latencyMs += r2.latencyMs;
        if (r2.error || !r2.text) error = r2.error ?? "empty call-2";
        else finalText = r2.text;
      }
    } else {
      const r1 = await ask([sys, user1], MT_ANSWER);
      inputTokens += r1.inputTokens;
      outputTokens += r1.outputTokens;
      latencyMs += r1.latencyMs;
      if (r1.error || !r1.text) error = r1.error ?? "empty call";
      else finalText = r1.text;
    }

    let correct = false;
    let parsed: Answer | null = null;
    if (finalText) {
      const raw = lastJson(finalText);
      parsed = coerce(raw ? unskinAnswer(raw) : null);
      if (parsed) {
        try {
          correct = t.q.grade(t.scene, parsed);
        } catch {
          /* malformed costs its item */
        }
      }
    }
    return {
      sceneId: t.scene.id,
      arm: t.arm,
      questionId: t.q.id,
      correct,
      usedTools,
      toolLinesOk,
      inputTokens,
      outputTokens,
      latencyMs,
      answer: JSON.stringify(parsed ?? null),
      error,
    };
  }

  async function worker(): Promise<void> {
    for (;;) {
      const t = tasks.shift();
      if (!t) return;
      rows.push(await runOne(t));
      done++;
      if (done % 40 === 0) console.log(`${done}/${total}`);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));

  mkdirSync(OUT, { recursive: true });
  const esc = (v: unknown) =>
    /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  writeFileSync(
    `${OUT}/results.csv`,
    [
      "sceneId,arm,questionId,correct,usedTools,toolLinesOk,inputTokens,outputTokens,latencyMs,answer,error",
      ...rows.map((r) =>
        [r.sceneId, r.arm, r.questionId, r.correct, r.usedTools, r.toolLinesOk, r.inputTokens, r.outputTokens, r.latencyMs, esc(r.answer), esc(r.error)].join(","),
      ),
    ].join("\n"),
    "utf8",
  );

  for (const arm of ["textmap2", "json"]) {
    const a = rows.filter((r) => r.arm === arm);
    const ok = a.filter((r) => r.correct).length;
    const errs = a.filter((r) => r.error).length;
    const toolItems = a.filter((r) => r.usedTools);
    const marshalFails = toolItems.filter((r) => !r.toolLinesOk).length;
    console.log(
      `${arm}: ${((100 * ok) / a.length).toFixed(1)}% (${ok}/${a.length}, errors ${errs}, tool items ${toolItems.length}, marshal-fails ${marshalFails})`,
    );
  }
  console.log("\n=== per question (both arms) ===");
  const byQ = new Map<string, { n: number; ok: number }>();
  for (const r of rows) {
    const e = byQ.get(r.questionId) ?? { n: 0, ok: 0 };
    e.n++;
    if (r.correct) e.ok++;
    byQ.set(r.questionId, e);
  }
  for (const [q, e] of byQ) console.log(`${q.padEnd(20)} ${((100 * e.ok) / e.n).toFixed(0)}%  (${e.ok}/${e.n})`);
  console.log(`wrote ${OUT}/results.csv`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

export {};
