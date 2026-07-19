/**
 * SFT v3.1 self-distillation generator — the fix for the micro-canary's
 * reasoning-channel damage (2026-07-19, ft-6ecd701c-450c postmortem).
 *
 * WHAT THE CANARY SHOWED: v3 targets are terse final answers with NO
 * reasoning content, so on a Harmony reasoning model every gradient step
 * also teaches "think nothing" (empty analysis channel). At 20%-epoch the
 * model had learned to stop deliberating before it absorbed the competence
 * deliberation used to provide — empty-array answers on every enumerate
 * family, and accuracy DEGRADING as reasoning effort rises (60 fast /
 * 45 low / 40 high vs base 80 low).
 *
 * THE FIX: distill the base model's OWN reasoning back into the targets.
 *  - Teacher = untrained openai/gpt-oss-20b under the full eval scaffold at
 *    "Reasoning: low" (its best measured config).
 *  - Each task-bank example is POSED to the teacher (real 2-call executor
 *    loop, exactly sft-eval-v2's protocol); we harvest the API's separate
 *    message.reasoning field per call.
 *  - ORACLE FILTER: a trace survives only if its final answer grades
 *    correct (core families: the real grader; bank families: normalized
 *    deep-equality vs the built label). We train only on reasoning that
 *    demonstrably reached the right answer (rejection sampling).
 *  - Rows keep the v3 masked 2-call shape, but assistant turns now carry
 *    {"reasoning": <teacher trace>} alongside content — Together's format
 *    trains it into the analysis channel (verified in their data-prep doc).
 *  - The "Reasoning: low" directive is present when ASKING the teacher but
 *    STRIPPED from the stored system turn: low-effort thinking becomes the
 *    model's default, not a string-triggered mode.
 *  - MARSHAL SLICE: teacher pass-rate is low exactly on the tool-heavy
 *    families, so tool-call supervision would thin out. We re-emit a slice
 *    of v3's 5-message rows with the terse final-answer turn at weight 0 —
 *    keeping their (correct-by-construction) marshal turns as supervision
 *    without re-teaching answer-without-thinking.
 *
 * Scenes ride fresh eval-disjoint train tiles (same LEGACY_LATTICE
 * rejection as sft-generate-v2, new seed base) with the same 6 vocabulary
 * skins; grading reverse-maps skinned ids/fields before comparison.
 *
 * Usage (spend-gated — every run costs teacher inference):
 *   TOGETHER_API_KEY=... pnpm exec tsx sft-distill.mts \
 *     --scenes 60 --out sft-data-v31 [--limit 6] [--concurrency 6] \
 *     [--model openai/gpt-oss-20b] [--reasoning low] \
 *     [--marshal-frac 0.2] [--v3 sft-data-v3/train.jsonl]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fetchRealOSMByAoi } from "./app/api/experiments/repr-eval/osm-fetch";
import { GEO_TOOLS_SPEC, executeGeoToolLines } from "./experiments/spatial-repr-eval/core/geo-tools";
import { hintFor } from "./experiments/spatial-repr-eval/core/hints";
import { buildRealScene } from "./experiments/spatial-repr-eval/core/real-scene";
import { QUESTIONS, type Answer } from "./experiments/spatial-repr-eval/core/questions";
import type { Scene } from "./experiments/spatial-repr-eval/core/scene";
import { FAMILIES, TEMPLATE_TOTAL } from "./experiments/spatial-repr-eval/core/task-bank";
import { toTextMapV2 } from "./experiments/spatial-repr-eval/core/textmap";

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const N_SCENES = Number(arg("scenes", "60"));
const OUT_DIR = arg("out", "sft-data-v31");
const SEED_BASE = Number(arg("seed-base", "70000"));
const VAL_EVERY = Number(arg("val-every", "50"));
const LIMIT = Number(arg("limit", "0")); // cap teacher conversations (smoke)
const MODEL = arg("model", "openai/gpt-oss-20b");
const CONC = Number(arg("concurrency", "6"));
const API_BASE = arg("api-base", "https://api.together.xyz").replace(/\/$/, "");
const MT_ANSWER = Number(arg("mt-answer", "8000"));
const MT_TOOLS = Number(arg("mt-tools", "12000"));
const REASONING = arg("reasoning", "low");
const MARSHAL_FRAC = Number(arg("marshal-frac", "0.2"));
const V3_TRAIN = arg("v3", "sft-data-v3/train.jsonl");
const KEY = process.env[arg("key-env", "TOGETHER_API_KEY")];
if (!KEY) {
  console.error("need an API key in the env named by --key-env");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// deterministic rng (mirror of sft-generate-v2.mts)
// ---------------------------------------------------------------------------
const hash32 = (str: string): number => {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};
const lcgFrom = (seed: number): (() => number) => {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s / 4294967296;
  };
};

// ---------------------------------------------------------------------------
// train tiles disjoint from the legacy eval lattice (mirror — keep in sync)
// ---------------------------------------------------------------------------
interface Box {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}
const SLICE: Box = { minLon: -74.011, minLat: 40.732, maxLon: -73.957, maxLat: 40.778 };
const NYC_CENTER: [number, number] = [-73.984, 40.7549];
const LEGACY_JITTER = 0.02;
const TILE_M = 350;
const PAD_M = 100;

const boxAround = (lng: number, lat: number, sizeM: number): Box => {
  const halfLat = sizeM / 2 / 110540;
  const halfLng = sizeM / 2 / (111320 * Math.cos((lat * Math.PI) / 180));
  return { minLon: lng - halfLng, maxLon: lng + halfLng, minLat: lat - halfLat, maxLat: lat + halfLat };
};
const intersects = (a: Box, b: Box): boolean =>
  a.minLon < b.maxLon && a.maxLon > b.minLon && a.minLat < b.maxLat && a.maxLat > b.minLat;

const LEGACY_LATTICE: Box[] = Array.from({ length: 100 }, (_, r) => {
  const jLng = (((r * 73) % 100) / 100 - 0.5) * LEGACY_JITTER;
  const jLat = (((r * 91) % 100) / 100 - 0.5) * LEGACY_JITTER;
  return boxAround(NYC_CENTER[0] + jLng, NYC_CENTER[1] + jLat, TILE_M + 2 * PAD_M);
});

const tileStats = { accepted: 0, rejected: 0 };
function trainAoi(seed: number): Box {
  const rand = lcgFrom(hash32(`tile|${seed}`));
  const half = boxAround(SLICE.minLon, (SLICE.minLat + SLICE.maxLat) / 2, TILE_M);
  const mLon = (half.maxLon - half.minLon) / 2 + 0.001;
  const mLat = (half.maxLat - half.minLat) / 2 + 0.001;
  for (let attempt = 0; attempt < 500; attempt++) {
    const lng = SLICE.minLon + mLon + rand() * (SLICE.maxLon - SLICE.minLon - 2 * mLon);
    const lat = SLICE.minLat + mLat + rand() * (SLICE.maxLat - SLICE.minLat - 2 * mLat);
    const box = boxAround(lng, lat, TILE_M);
    if (LEGACY_LATTICE.some((l) => intersects(box, l))) {
      tileStats.rejected++;
      continue;
    }
    tileStats.accepted++;
    return box;
  }
  throw new Error(`no eval-disjoint tile found for seed ${seed} after 500 attempts`);
}

// ---------------------------------------------------------------------------
// json arm (mirror of sft-generate-v2.mts — keep in sync)
// ---------------------------------------------------------------------------
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
// skins with BOTH directions (mirror of sft-eval-v2.mts SKIN_PAIRS)
// ---------------------------------------------------------------------------
type Rule = [RegExp, string];
interface SkinPair {
  id: string;
  forward: Rule[];
  reverseIds: Rule[];
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
const skinFwd = (text: string, skin: SkinPair): string => {
  let out = text;
  for (const [re, repl] of skin.forward) out = out.replace(re, repl);
  return out;
};
const unskinId = (v: string, skin: SkinPair): string => {
  let out = v;
  for (const [re, repl] of skin.reverseIds) out = out.replace(re, repl);
  return out;
};
const unskinAnswer = (a: Record<string, unknown>, skin: SkinPair): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a)) {
    const key = skin.reverseFields[k] ?? k;
    if (typeof v === "string") out[key] = unskinId(v, skin);
    else if (Array.isArray(v)) out[key] = v.map((x) => (typeof x === "string" ? unskinId(x, skin) : x));
    else out[key] = v;
  }
  return out;
};
const pickSkin = (rand: () => number): SkinPair => {
  if (rand() < 0.2) return SKIN_PAIRS[5]; // generic ~20%
  return SKIN_PAIRS[Math.floor(rand() * 5) % 5];
};

// ---------------------------------------------------------------------------
// message assembly (mirror — keep in sync)
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

function hintText(familyId: string, arm: "textmap2" | "json", isCompute: boolean): string {
  if ((familyId === "crossing" || familyId === "crossing_boolean") && isCompute) {
    return `\nHINT: ${CROSSING_TOOL_HINT[arm]}`;
  }
  return hintFor(familyId, arm);
}

// ---------------------------------------------------------------------------
// teacher calls (OpenAI-compatible; harvests message.reasoning)
// ---------------------------------------------------------------------------
interface Msg {
  role: "system" | "user" | "assistant";
  content: string;
  /** teacher analysis-channel trace — trains the reasoning channel */
  reasoning?: string;
  /** per-message loss mask (marshal slice: final terse turn gets 0) */
  weight?: number;
}
interface Row {
  messages: Msg[];
}
interface AskRes {
  text?: string;
  reasoning?: string;
  error?: string;
  inputTokens: number;
  outputTokens: number;
}

async function ask(messages: Msg[], maxTokens: number): Promise<AskRes> {
  const first = await askOnce(messages, maxTokens);
  if (first.error && !/^\d{3}:/.test(first.error)) return askOnce(messages, maxTokens);
  return first;
}

async function askOnce(messages: Msg[], maxTokens: number): Promise<AskRes> {
  try {
    const r = await fetch(`${API_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        max_tokens: maxTokens,
        // strip local-only fields before sending
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        stream: false,
      }),
      signal: AbortSignal.timeout(240_000),
    });
    if (!r.ok)
      return { error: `${r.status}: ${(await r.text()).slice(0, 120)}`, inputTokens: 0, outputTokens: 0 };
    const data = (await r.json()) as {
      choices?: { message?: { content?: string; reasoning?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      text: data.choices?.[0]?.message?.content ?? "",
      reasoning: data.choices?.[0]?.message?.reasoning ?? "",
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
    };
  } catch (e) {
    return { error: `transport: ${(e as Error).message.slice(0, 100)}`, inputTokens: 0, outputTokens: 0 };
  }
}

// ---------------------------------------------------------------------------
// answer parsing + oracle comparison
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

function coerce(a: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!a || typeof a !== "object") return null;
  const out: Record<string, unknown> = { ...a };
  for (const k of ["equipmentIds", "cableIds", "buildingIds", "equipmentPath"]) {
    if (typeof out[k] === "string") out[k] = out[k] === "none" || out[k] === "" ? [] : [out[k]];
  }
  if (typeof out.count === "string") out.count = Number(out.count);
  if (typeof out.onStreet === "string") out.onStreet = (out.onStreet as string).toLowerCase() === "true";
  return out;
}

/** Bank-family oracle check: every oracle key must match in the parsed answer
 *  (arrays order-insensitive; distance-like numbers get ±0.6 m rounding slack;
 *  everything else exact). Extra parsed keys are ignored, like the graders. */
function matchesOracle(oracle: Record<string, unknown>, parsed: Record<string, unknown>): boolean {
  for (const [k, want] of Object.entries(oracle)) {
    const got = parsed[k];
    if (Array.isArray(want)) {
      if (!Array.isArray(got)) return false;
      const a = [...want].map(String).sort();
      const b = [...got].map(String).sort();
      if (a.length !== b.length || a.some((x, i) => x !== b[i])) return false;
    } else if (typeof want === "number") {
      if (typeof got !== "number" || Number.isNaN(got)) return false;
      const slack = /meters|dist|length/i.test(k) ? 0.6 : 0;
      if (Math.abs(got - want) > slack) return false;
    } else if (want !== got) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// marshal slice — v3 tool rows with the terse final turn masked out
// ---------------------------------------------------------------------------
function marshalSlice(count: number): Row[] {
  if (count <= 0 || !existsSync(V3_TRAIN)) return [];
  const lines = readFileSync(V3_TRAIN, "utf8").split("\n").filter(Boolean);
  const toolRows: Row[] = [];
  for (const line of lines) {
    const row = JSON.parse(line) as Row;
    if (row.messages.length === 5) toolRows.push(row);
  }
  const rand = lcgFrom(7654321);
  for (let i = toolRows.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [toolRows[i], toolRows[j]] = [toolRows[j], toolRows[i]];
  }
  return toolRows.slice(0, count).map((row) => ({
    messages: row.messages.map((m, i) =>
      m.role === "assistant" ? { ...m, weight: i === row.messages.length - 1 ? 0 : 1 } : m,
    ),
  }));
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log(
    `teacher=${MODEL} reasoning=${REASONING || "(default)"} scenes=${N_SCENES} conc=${CONC}${LIMIT ? ` limit=${LIMIT}` : ""}`,
  );
  const coreQ = new Map(QUESTIONS.map((q) => [q.id, q]));

  interface Task {
    scene: Scene;
    famId: string;
    kind: "read" | "compute";
    arm: "textmap2" | "json";
    skin: SkinPair;
    prompt: string;
    oracle: Record<string, unknown>;
    rep: string;
  }
  const tasks: Task[] = [];
  let sceneFails = 0;
  let familySkips = 0;

  for (let i = 0; i < N_SCENES; i++) {
    const seed = SEED_BASE + i;
    let scene: Scene;
    try {
      const aoi = trainAoi(seed);
      const { buildings, streets } = await fetchRealOSMByAoi("nyc", aoi);
      scene = buildRealScene({
        id: `d-${seed}`,
        buildings,
        streets,
        maxBuildings: 8 + (i % 7),
        plant: {
          ...[{}, { closureInBuilding: true }, { cableCrossing: true }, { coverageGap: true }][i % 4],
          closureOnStreet: i % 2 === 0,
        },
      });
    } catch (e) {
      sceneFails++;
      console.error(`skip seed ${seed}: ${(e as Error).message}`);
      continue;
    }
    const reps: Record<"textmap2" | "json", string> = {
      textmap2: toTextMapV2(scene, { zoom: 1, rings: true, feeds: true, worldFacts: true }),
      json: toJSON(scene),
    };
    for (const fam of FAMILIES) {
      // weak-teacher compute families need 2× attempts to survive the filter
      const repeats = fam.kind === "compute" ? 2 : 1;
      for (let rep = 0; rep < repeats; rep++) {
        const rand = lcgFrom(hash32(`${scene.id}|${fam.id}|${rep}`));
        const ex = fam.build(scene, rand);
        if (!ex) {
          familySkips++;
          continue;
        }
        const q = coreQ.get(fam.id);
        if (q && !q.grade(scene, ex.answer as Answer)) continue; // bad label — never pose it
        const skin = pickSkin(lcgFrom(hash32(`${scene.id}|${fam.id}|${rep}|skin`)));
        for (const arm of ["textmap2", "json"] as const) {
          tasks.push({
            scene,
            famId: fam.id,
            kind: fam.kind === "compute" ? "compute" : "read",
            arm,
            skin,
            prompt: ex.prompt,
            oracle: ex.answer as Record<string, unknown>,
            rep: reps[arm],
          });
        }
      }
    }
  }
  const posed = LIMIT > 0 ? tasks.slice(0, LIMIT) : tasks;
  console.log(`${posed.length} teacher conversations queued (${sceneFails} scene fails, ${familySkips} family skips)`);

  const rows: Row[] = [];
  const famPass: Record<string, { posed: number; kept: number }> = {};
  const skinCount: Record<string, number> = {};
  let usedToolsKept = 0;
  let directKept = 0;
  let errors = 0;
  let inTok = 0;
  let outTok = 0;
  let done = 0;

  async function runOne(t: Task): Promise<void> {
    const stat = (famPass[t.famId] ??= { posed: 0, kept: 0 });
    stat.posed++;
    const hint = hintText(t.famId, t.arm, t.kind === "compute");
    const userParts = [
      t.rep,
      "",
      ...(t.kind === "compute" ? [GEO_TOOLS_SPEC, ""] : []),
      "QUESTION:",
      `${t.prompt}${hint}`,
    ];
    // stored system turn: plain. asked system turn: + the reasoning directive.
    const sysStored: Msg = { role: "system", content: skinFwd(SYSTEM, t.skin) };
    const sysAsked: Msg = {
      role: "system",
      content: sysStored.content + (REASONING ? `\n\nReasoning: ${REASONING}` : ""),
    };
    const user1: Msg = { role: "user", content: skinFwd(userParts.join("\n"), t.skin) };

    let finalText = "";
    let msgs: Msg[] | null = null;

    if (t.kind === "compute") {
      const r1 = await ask([sysAsked, user1], MT_TOOLS);
      inTok += r1.inputTokens;
      outTok += r1.outputTokens;
      if (r1.error || !r1.text) {
        errors++;
        return;
      }
      if (/ANSWER:\s*\{/.test(r1.text) && !/TOOL_CALLS:/.test(r1.text)) {
        // teacher answered directly — legitimate iff it survives the oracle
        finalText = r1.text;
        msgs = [sysStored, user1, { role: "assistant", content: r1.text, ...(r1.reasoning ? { reasoning: r1.reasoning } : {}) }];
        if (finalOk(t, finalText)) directKept++;
      } else {
        const results = executeGeoToolLines(r1.text);
        if (!results) return; // marshal failure — nothing worth training on
        const user2: Msg = {
          role: "user",
          content: skinFwd(
            `${TOOL_RESULTS_PREFIX}\n${results}\n\nNow give the final answer as the line: ANSWER: {json}`,
            t.skin,
          ),
        };
        const r2 = await ask([sysAsked, user1, { role: "assistant", content: r1.text }, user2], MT_ANSWER);
        inTok += r2.inputTokens;
        outTok += r2.outputTokens;
        if (r2.error || !r2.text) {
          errors++;
          return;
        }
        finalText = r2.text;
        msgs = [
          sysStored,
          user1,
          { role: "assistant", content: r1.text, ...(r1.reasoning ? { reasoning: r1.reasoning } : {}) },
          user2,
          { role: "assistant", content: r2.text, ...(r2.reasoning ? { reasoning: r2.reasoning } : {}) },
        ];
        if (finalOk(t, finalText)) usedToolsKept++;
      }
    } else {
      const r1 = await ask([sysAsked, user1], MT_ANSWER);
      inTok += r1.inputTokens;
      outTok += r1.outputTokens;
      if (r1.error || !r1.text) {
        errors++;
        return;
      }
      finalText = r1.text;
      msgs = [sysStored, user1, { role: "assistant", content: r1.text, ...(r1.reasoning ? { reasoning: r1.reasoning } : {}) }];
    }

    if (!msgs || !finalOk(t, finalText)) return;
    rows.push({ messages: msgs });
    stat.kept++;
    skinCount[t.skin.id] = (skinCount[t.skin.id] ?? 0) + 1;
  }

  function finalOk(t: Task, finalText: string): boolean {
    const raw = lastJson(finalText);
    const parsed = coerce(raw ? unskinAnswer(raw, t.skin) : null);
    if (!parsed) return false;
    const q = coreQ.get(t.famId);
    try {
      return q ? q.grade(t.scene, parsed as Answer) : matchesOracle(t.oracle, parsed);
    } catch {
      return false;
    }
  }

  const queue = [...posed];
  async function worker(): Promise<void> {
    for (;;) {
      const t = queue.shift();
      if (!t) return;
      await runOne(t);
      done++;
      if (done % 100 === 0) {
        console.log(`${done}/${posed.length} — kept ${rows.length}, errors ${errors}, tok ${(inTok / 1e6).toFixed(1)}M in / ${(outTok / 1e6).toFixed(1)}M out`);
        flush(false); // crash-safe partial
      }
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));

  // marshal slice sized against what survived
  const nMarshal = Math.round((rows.length * MARSHAL_FRAC) / (1 - MARSHAL_FRAC));
  const marshal = marshalSlice(nMarshal);
  rows.push(...marshal);

  // deterministic shuffle
  const shuffleRand = lcgFrom(1234567);
  for (let i = rows.length - 1; i > 0; i--) {
    const j = Math.floor(shuffleRand() * (i + 1));
    [rows[i], rows[j]] = [rows[j], rows[i]];
  }
  flush(true);

  function flush(final: boolean): void {
    mkdirSync(OUT_DIR, { recursive: true });
    const val = final ? rows.filter((_, i) => i % VAL_EVERY === 0) : [];
    const train = final ? rows.filter((_, i) => i % VAL_EVERY !== 0) : rows;
    writeFileSync(`${OUT_DIR}/train.jsonl`, train.map((r) => JSON.stringify(r)).join("\n"), "utf8");
    if (final) writeFileSync(`${OUT_DIR}/val.jsonl`, val.map((r) => JSON.stringify(r)).join("\n"), "utf8");
    if (!final) return;
    const chars = rows.reduce(
      (n, r) => n + r.messages.reduce((m, x) => m + x.content.length + (x.reasoning?.length ?? 0), 0),
      0,
    );
    const manifest = {
      generated: "sft-distill (v3.1 self-distillation)",
      teacher: MODEL,
      reasoningAsked: REASONING,
      scenes: N_SCENES,
      seedBase: SEED_BASE,
      tileStats,
      templateTotal: TEMPLATE_TOTAL,
      famPass,
      skins: skinCount,
      kept: { total: rows.length, distilled: rows.length - marshal.length, marshalSlice: marshal.length, viaTools: usedToolsKept, direct: directKept },
      posed: posed.length,
      errors,
      teacherTokens: { inputM: +(inTok / 1e6).toFixed(1), outputM: +(outTok / 1e6).toFixed(1) },
      counts: { train: train.length, val: val.length },
      // chars/2.9 — Together's tokenizer measured JSON-heavy text there (v3 lesson)
      approxTokensM: Math.round(chars / 2.9 / 1e6),
    };
    writeFileSync(`${OUT_DIR}/manifest.json`, JSON.stringify(manifest, null, 2), "utf8");
  }

  const kept = rows.length;
  console.log(`\nkept ${kept} rows (${kept - marshal.length} distilled + ${marshal.length} marshal-slice)`);
  console.log(`teacher spend: ${(inTok / 1e6).toFixed(1)}M in / ${(outTok / 1e6).toFixed(1)}M out tokens, errors ${errors}`);
  const passTotal = Object.values(famPass).reduce((a, s) => a + s.kept, 0);
  const posedTotal = Object.values(famPass).reduce((a, s) => a + s.posed, 0);
  console.log(`oracle pass rate: ${((100 * passTotal) / Math.max(1, posedTotal)).toFixed(0)}% overall`);
  for (const [fam, s] of Object.entries(famPass).sort((a, b) => a[1].kept / a[1].posed - b[1].kept / b[1].posed)) {
    if (s.kept / s.posed < 0.4) console.log(`  weak family ${fam}: ${s.kept}/${s.posed}`);
  }
  console.log(`wrote ${OUT_DIR}/train.jsonl, val.jsonl, manifest.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

export {};
