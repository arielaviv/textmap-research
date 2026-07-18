/**
 * SFT v2 training-data generator (prereg E2 revision — supersedes
 * experiments/spatial-repr-eval/sft-generate.mjs, kept as the v1 artifact).
 *
 * Fixes the three defects of the v1 recipe (docs/argus-v2-training-plan.md §2)
 * plus the 2026-07-19 audit findings:
 *
 *  DEFECT A — real 2-call, masked. Compute examples are FIVE messages:
 *    system / user(map+spec+question) / assistant(EXTRACTION+TOOL_CALLS) /
 *    user(TOOL_RESULTS) / assistant(derivation+ANSWER).
 *    The tool results ride a USER turn, so with train_on_inputs=false the
 *    loss never covers engine output — the model is trained to CALL the
 *    executor, not to imitate it. TOOL_RESULTS text comes from actually
 *    running executeGeoToolLines on the emitted calls (format-faithful), and
 *    each example asserts the derived answer equals the oracle's — a
 *    disagreement (boundary rounding) skips the example, never poisons it.
 *    The pre-tool assistant turn contains ONLY marshaled inputs, never the
 *    conclusion (v1 baked the verdict into EXTRACTION).
 *
 *  DEFECT B — task-schema diversity. Families + templates come from
 *    core/task-bank.ts (~30 trained families, >300 unique templates, novel
 *    output schemas). Hold-out families are never generated.
 *
 *  DEFECT C — spatial tile split. The legacy aoiForCity jitter is DEGENERATE:
 *    (seed*73)%100 / (seed*91)%100 depend only on seed%100, so every seed
 *    collapses onto a 100-point lattice and v1's "disjoint" train seeds
 *    51000+i sat on EXACTLY the eval AOIs of 2000+i. Train AOIs here come
 *    from a real hash over the full bundled NYC slice and are REJECTED if
 *    they intersect ANY of the 100 legacy lattice tiles (padded) — geographic
 *    disjointness from every legacy eval seed at ≤350m, by construction.
 *    London/Phoenix stay eval-only.
 *
 *  VOCABULARY SKINNING — each example is rendered in one of 6 vocabularies
 *    (ftth / water / electric / sensor / logistics + ~20% generic), a
 *    consistent lexical bijection over ids and kind words with geometry
 *    fixed — the domain-generality lever.
 *
 * Run (no dev server, no API keys, free):
 *   NODE_OPTIONS=--max-old-space-size=2048 pnpm exec tsx sft-generate-v2.mts \
 *     --scenes 180 --out sft-data-v3
 *   (fallback runner: node --experimental-strip-types --no-warnings)
 *
 * Training config note: use train_on_inputs=false (mask non-assistant turns).
 * The inference loop (sft-eval v2, follow-up work) must mirror the same
 * conversation shape: call 1 → TOOL_CALLS, execute, call 2 → ANSWER.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { fetchRealOSMByAoi } from "./app/api/experiments/repr-eval/osm-fetch";
import { GEO_TOOLS_SPEC, executeGeoToolLines } from "./experiments/spatial-repr-eval/core/geo-tools";
import { hintFor } from "./experiments/spatial-repr-eval/core/hints";
import { buildRealScene } from "./experiments/spatial-repr-eval/core/real-scene";
import { QUESTIONS, type Answer } from "./experiments/spatial-repr-eval/core/questions";
import type { Scene } from "./experiments/spatial-repr-eval/core/scene";
import {
  FAMILIES,
  HELDOUT_RESERVED,
  TEMPLATE_TOTAL,
  type TaskFamily,
} from "./experiments/spatial-repr-eval/core/task-bank";
import { toTextMapV2 } from "./experiments/spatial-repr-eval/core/textmap";

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const N_SCENES = Number(arg("scenes", "180"));
const OUT_DIR = arg("out", "sft-data-v3");
const SEED_BASE = Number(arg("seed-base", "60000"));
const VAL_EVERY = Number(arg("val-every", "50"));

if (TEMPLATE_TOTAL <= 300) {
  throw new Error(`task bank has ${TEMPLATE_TOTAL} templates — the prereg requires >300`);
}

// ---------------------------------------------------------------------------
// deterministic rng
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
// DEFECT C — train tiles disjoint from the legacy eval lattice
// ---------------------------------------------------------------------------
interface Box {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}
// The committed NYC slice (data/osm/*/new-york.json bbox).
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

/** All 100 possible legacy AOIs (every historical seed collapses onto these),
 *  padded — the exclusion zone for training tiles. */
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
// json arm (faithful copy of representations.ts toJSON, as in the v1 generator)
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
// vocabulary skins — consistent lexical bijections, geometry fixed
// ---------------------------------------------------------------------------
type Rule = [RegExp, string];
interface Skin {
  id: string;
  rules: Rule[];
}
const SKINS: Skin[] = [
  { id: "ftth", rules: [] },
  {
    id: "water",
    rules: [
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
  },
  {
    id: "electric",
    rules: [
      [/closure/g, "transformer"], [/Closure/g, "Transformer"], [/CLOSURE/g, "TRANSFORMER"],
      [/\bCL-/g, "TR-"],
      [/central office/g, "substation"], [/Central Office/g, "Substation"],
      [/kind=co\b/g, "kind=substation"], [/"kind":"co"/g, '"kind":"substation"'],
      [/\bCO-(\d+)/g, "SS-$1"], [/\bCO\b/g, "substation"],
      [/FTTH/g, "electric-grid"],
    ],
  },
  {
    id: "sensor",
    rules: [
      [/closure/g, "sensor"], [/Closure/g, "Sensor"], [/CLOSURE/g, "SENSOR"],
      [/\bCL-/g, "SN-"],
      [/central office/g, "gateway hub"], [/Central Office/g, "Gateway Hub"],
      [/kind=co\b/g, "kind=gateway"], [/"kind":"co"/g, '"kind":"gateway"'],
      [/\bCO-(\d+)/g, "GW-$1"], [/\bCO\b/g, "gateway"],
      [/FTTH/g, "sensor-network"],
    ],
  },
  {
    id: "logistics",
    rules: [
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
  },
  {
    id: "generic",
    rules: [
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
  },
];
const applySkin = (text: string, skin: Skin): string => {
  let out = text;
  for (const [re, repl] of skin.rules) out = out.replace(re, repl);
  return out;
};
const pickSkin = (rand: () => number): Skin => {
  if (rand() < 0.2) return SKINS[5]; // generic ~20%
  return SKINS[Math.floor(rand() * 5) % 5];
};

// ---------------------------------------------------------------------------
// message assembly
// ---------------------------------------------------------------------------
const SYSTEM =
  "You are a precise spatial-analysis assistant for GIS / FTTH network data. " +
  "You are given a representation of a small map (buildings, streets, equipment, cables) and ONE question. " +
  "If the question needs geometric computation, first reply with an EXTRACTION: section (the relevant " +
  "facts and coordinates exactly as they appear in the representation) followed by a TOOL_CALLS: section " +
  "containing ONLY JSON tool lines; you will receive TOOL_RESULTS back, and then you reply with the final " +
  "line ANSWER: {json object with ONLY the requested field(s)}. If no computation is needed, reply " +
  "EXTRACTION: then ANSWER: directly. Ids must match exactly the ids present in the data. Do not invent ids.";

interface Msg {
  role: "system" | "user" | "assistant";
  content: string;
}
interface Row {
  messages: Msg[];
}

const TOOL_RESULTS_PREFIX =
  "TOOL_RESULTS (computed exactly from the coordinates you supplied — trust these numbers over " +
  "mental arithmetic):";

/** Tool-mode crossing hints (mirror engine.toolCrossingHint per arm). */
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
// main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const rows: Row[] = [];
  const famCount: Record<string, number> = {};
  const skinCount: Record<string, number> = {};
  let sceneFails = 0;
  let gradeFails = 0;
  let concludeFails = 0;
  let familySkips = 0;

  const coreQ = new Map(QUESTIONS.map((q) => [q.id, q]));

  for (let i = 0; i < N_SCENES; i++) {
    const seed = SEED_BASE + i;
    let scene: Scene;
    try {
      const aoi = trainAoi(seed);
      const { buildings, streets } = await fetchRealOSMByAoi("nyc", aoi);
      scene = buildRealScene({
        id: `t-${seed}`,
        buildings,
        streets,
        maxBuildings: 8 + (i % 7), // 8..14 — size variety around the eval's 12
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
      // compute-bound families are oversampled 2× (the v1 error-loop carry-over)
      const repeats = fam.kind === "compute" ? 2 : 1;
      for (let rep = 0; rep < repeats; rep++) {
        const rand = lcgFrom(hash32(`${scene.id}|${fam.id}|${rep}`));
        const ex = fam.build(scene, rand);
        if (!ex) {
          familySkips++;
          continue;
        }
        // Core-family self-check: the label must grade correct under the real grader.
        const q = coreQ.get(fam.id);
        if (q && !q.grade(scene, ex.answer as Answer)) {
          gradeFails++;
          continue;
        }
        // Compute: run the REAL executor on the emitted calls; derive the
        // post-tool turn from its output; skip on any inconsistency.
        let toolResults: string | null = null;
        let derivation: string | null = null;
        if (ex.toolCalls && ex.toolCalls.length > 0) {
          toolResults = executeGeoToolLines(ex.toolCalls.join("\n"));
          derivation = toolResults && ex.conclude ? ex.conclude(toolResults) : null;
          if (!toolResults || !derivation) {
            concludeFails++;
            continue;
          }
        }

        const skinRand = lcgFrom(hash32(`${scene.id}|${fam.id}|${rep}|skin`));
        const skin = pickSkin(skinRand);
        const answerLine = `ANSWER: ${JSON.stringify(ex.answer)}`;

        for (const arm of ["textmap2", "json"] as const) {
          const hint = hintText(fam.id, arm, !!ex.toolCalls);
          const isCompute = !!(ex.toolCalls && toolResults && derivation);
          const userParts = [
            reps[arm],
            "",
            ...(isCompute ? [GEO_TOOLS_SPEC, ""] : []),
            "QUESTION:",
            `${ex.prompt}${hint}`,
          ];
          const messages: Msg[] = [{ role: "system", content: SYSTEM }];
          messages.push({ role: "user", content: userParts.join("\n") });
          if (isCompute) {
            messages.push({
              role: "assistant",
              content: `EXTRACTION:\n${ex.extraction}\n\nTOOL_CALLS:\n${(ex.toolCalls as string[]).join("\n")}`,
            });
            messages.push({
              role: "user",
              content: `${TOOL_RESULTS_PREFIX}\n${toolResults}\n\nNow give the final answer as the line: ANSWER: {json}`,
            });
            messages.push({ role: "assistant", content: `${derivation}\n${answerLine}` });
          } else {
            messages.push({
              role: "assistant",
              content: `EXTRACTION:\n${ex.extraction}\n\n${answerLine}`,
            });
          }
          rows.push({
            messages: messages.map((m) => ({ ...m, content: applySkin(m.content, skin) })),
          });
          famCount[fam.id] = (famCount[fam.id] ?? 0) + 1;
          skinCount[skin.id] = (skinCount[skin.id] ?? 0) + 1;
        }
      }
    }
    if ((i + 1) % 20 === 0) console.log(`${i + 1}/${N_SCENES} scenes, ${rows.length} rows`);
  }

  // Deterministic shuffle (LCG) so formats/families/skins interleave.
  const shuffleRand = lcgFrom(1234567);
  for (let i = rows.length - 1; i > 0; i--) {
    const j = Math.floor(shuffleRand() * (i + 1));
    [rows[i], rows[j]] = [rows[j], rows[i]];
  }
  const val = rows.filter((_, i) => i % VAL_EVERY === 0);
  const train = rows.filter((_, i) => i % VAL_EVERY !== 0);

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(`${OUT_DIR}/train.jsonl`, train.map((r) => JSON.stringify(r)).join("\n"), "utf8");
  writeFileSync(`${OUT_DIR}/val.jsonl`, val.map((r) => JSON.stringify(r)).join("\n"), "utf8");

  const chars = rows.reduce(
    (n, r) => n + r.messages.reduce((m, x) => m + x.content.length, 0),
    0,
  );
  const manifest = {
    generated: "sft-generate-v2",
    scenes: N_SCENES,
    seedBase: SEED_BASE,
    tileStats,
    templateTotal: TEMPLATE_TOTAL,
    heldoutReserved: HELDOUT_RESERVED,
    families: famCount,
    skins: skinCount,
    counts: { train: train.length, val: val.length },
    skipped: { sceneFails, gradeFails, concludeFails, familySkips },
    approxTokensM: Math.round(chars / 4 / 1e6),
  };
  writeFileSync(`${OUT_DIR}/manifest.json`, JSON.stringify(manifest, null, 2), "utf8");

  console.log(`\nscenes ok: ${N_SCENES - sceneFails}/${N_SCENES}`);
  console.log(
    `rows: train ${train.length} + val ${val.length}  (grade-fails ${gradeFails}, conclude-fails ${concludeFails}, family-skips ${familySkips})`,
  );
  console.log(`tiles: ${tileStats.accepted} accepted, ${tileStats.rejected} rejected (eval-lattice overlap)`);
  console.log(`templates in bank: ${TEMPLATE_TOTAL} (>300 required)`);
  console.log(`~${manifest.approxTokensM}M tokens (chars/4 estimate)`);
  console.log(`wrote ${OUT_DIR}/train.jsonl, val.jsonl, manifest.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// Ambient module declaration guard: this file is a script, not a module import
// target — nothing exports from here.
export {};
