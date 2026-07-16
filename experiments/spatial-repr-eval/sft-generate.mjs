/**
 * SFT training-data generator (paper 1, prereg block E in docs/textmap-v2.md).
 *
 * Policy (fixed before generation):
 *  - Train seeds 50000+ — disjoint from EVERY eval range (1000-1059, 2000-2019,
 *    3000+ scale, 9500-9702 smokes); London never used.
 *  - The 6 HOLD-OUT question types are EXCLUDED — SFT generalization is
 *    measured on them.
 *  - Mix: ~80% synthetic / 20% real-NYC scenes; textmap2 zoom=1 AND json arms
 *    of the SAME scene×question pairs (one model learns both formats; the
 *    format gap is then measured within one checkpoint).
 *  - Assistant turns carry a synthetic extraction trace (programmatic, from
 *    the scene — the category-aware scan behavior baked in, OptiMind-style)
 *    followed by the oracle answer as a trailing "ANSWER: {json}" line.
 *
 * Run (dev server must be up — it exports scenes):
 *   node --experimental-strip-types --no-warnings \
 *     experiments/spatial-repr-eval/sft-generate.mjs --url http://localhost:3377
 *
 * Output: sft-data/train.jsonl, sft-data/val.jsonl (+ stats on stdout).
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
const N_SYNTH = Number(arg("synth", "240"));
const N_REAL = Number(arg("real", "60"));
// Seed bases are FLAGS so dataset generations never silently overlap:
// v1 = 50000/51000 (defaults); v2 additions = 52000/53000 (prereg E2).
const SYNTH_BASE = Number(arg("synth-base", "50000"));
const REAL_BASE = Number(arg("real-base", "51000"));
const OUT_DIR = arg("out", "sft-data");
const secret = process.env.EVAL_SECRET ?? "";
// v2 flags: diversity (paraphrase variants), tool-call traces, feeds=, rings.
const V2_DIVERSE = process.argv.includes("--diverse");
const V2_TOOLS = process.argv.includes("--tools");
const V2_FEEDS = process.argv.includes("--feeds");
const V2_RINGS = process.argv.includes("--rings");
const VARIANTS = Number(arg("variants", V2_DIVERSE ? "3" : "1")); // paraphrases per scene×question

// ---------------------------------------------------------------------------
// json arm — faithful copy of representations.ts toJSON (kept in sync by the
// verify step below, which diffs against the server's preview for one seed).
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Oracle answers per core question (the label side).
// ---------------------------------------------------------------------------
function oracleAnswer(qid, scene) {
  switch (qid) {
    case "containment":
      return { equipmentIds: oracle.closuresInsideBuildings(scene) };
    case "crossing":
      return { cableIds: oracle.cablesCrossingForeignBuildings(scene) };
    case "onstreet":
      return { onStreet: oracle.isOnStreet(scene, questions.firstClosureId(scene)) };
    case "nearest":
      return { closureId: oracle.nearestClosureToBuilding(scene, scene.buildings[0].id) ?? "none" };
    case "coverage_gap":
      return { buildingIds: oracle.coverageGapBuildings(scene) };
    case "topology":
      return { equipmentPath: oracle.pathToSource(scene, questions.topologyBuilding(scene)) };
    case "blockage": {
      const co = questions.coEquip(scene);
      const t = questions.blockageTarget(scene);
      return { buildingIds: co ? oracle.lineCrossesBuildings(scene, co.position, t.centroid, t.id) : [] };
    }
    case "road_misplacement":
      return { equipmentIds: oracle.equipmentInRoad(scene) };
    case "enclosure":
      return { buildingIds: oracle.interiorBuildings(scene) };
    case "nearest_offstreet":
      return {
        closureId:
          oracle.nearestClosureOffStreet(scene, questions.offstreetTargetBuilding(scene)) ?? "none",
      };
    default:
      throw new Error(`no oracle answer builder for ${qid}`);
  }
}

// ---------------------------------------------------------------------------
// Synthetic extraction traces — the category-aware scan behavior, written as
// the supervision target. True facts from the scene; short; format-neutral.
// ---------------------------------------------------------------------------
const closures = (s) => s.equipment.filter((e) => e.kind === "closure");
const dStreet = (s, pos) =>
  Math.min(...s.streets.map((st) => geo.pointToPolylineMeters(pos, st.coordinates)));

function trace(qid, scene) {
  const L = [];
  switch (qid) {
    case "containment": {
      for (const e of scene.equipment) {
        const inB = scene.buildings.find((b) => geo.pointInPolygon(e.position, b.footprint));
        L.push(`${e.id}: ${inB ? `inside ${inB.id}` : "outside every footprint"}`);
      }
      break;
    }
    case "crossing": {
      const crossing = new Set(oracle.cablesCrossingForeignBuildings(scene));
      for (const c of scene.cables) {
        L.push(
          `${c.id} (${c.sourceId} -> ${c.targetId}): ${
            crossing.has(c.id)
              ? "passes through a building it does not terminate at"
              : "only touches its own endpoints' buildings or none"
          }`,
        );
      }
      break;
    }
    case "onstreet": {
      const id = questions.firstClosureId(scene);
      const e = scene.equipment.find((x) => x.id === id);
      const d = dStreet(scene, e.position);
      L.push(`${id}: distance to nearest street centerline = ${d.toFixed(1)}m (threshold ~8m)`);
      break;
    }
    case "nearest": {
      const b = scene.buildings[0];
      const ds = closures(scene)
        .map((c) => ({ id: c.id, d: geo.haversineMeters(b.centroid, c.position) }))
        .sort((x, y) => x.d - y.d)
        .slice(0, 3);
      for (const { id, d } of ds) L.push(`${id}: ${d.toFixed(1)}m from ${b.id}`);
      break;
    }
    case "coverage_gap": {
      for (const b of scene.buildings) {
        const d = Math.min(
          ...closures(scene).map((c) => geo.haversineMeters(b.centroid, c.position)),
        );
        L.push(`${b.id}: nearest closure ${d.toFixed(1)}m${d > 35 ? "  -> GAP (>35m)" : ""}`);
      }
      break;
    }
    case "topology": {
      const bid = questions.topologyBuilding(scene);
      const serving = scene.equipment.find((e) => e.kind === "closure" && e.serves.includes(bid));
      const co = questions.coEquip(scene);
      L.push(`${bid} is served by ${serving?.id ?? "?"} (its serves= list contains ${bid}).`);
      if (co) L.push(`The network source is ${co.id}. Path nearest-first: serving closure, then source.`);
      break;
    }
    case "blockage": {
      const co = questions.coEquip(scene);
      const t = questions.blockageTarget(scene);
      const hits = co ? oracle.lineCrossesBuildings(scene, co.position, t.centroid, t.id) : [];
      L.push(`Straight segment ${co?.id ?? "CO"} -> ${t.id}.`);
      L.push(
        hits.length
          ? `Footprints the segment passes through (excluding ${t.id}): ${hits.join(", ")}`
          : `No other building's footprint intersects the segment.`,
      );
      break;
    }
    case "road_misplacement": {
      const inRoad = new Set(oracle.equipmentInRoad(scene));
      for (const e of scene.equipment) {
        if (e.kind === "co") continue;
        const d = dStreet(scene, e.position);
        L.push(`${e.id}: d_street=${d.toFixed(1)}m${inRoad.has(e.id) ? "  -> IN ROAD" : ""}`);
      }
      break;
    }
    case "enclosure": {
      const interior = oracle.interiorBuildings(scene);
      L.push(`Convex hull of building centroids computed.`);
      L.push(
        interior.length
          ? `Centroids NOT on the hull (interior): ${interior.join(", ")}`
          : `Every centroid lies on the hull — no interior buildings.`,
      );
      break;
    }
    case "nearest_offstreet": {
      const bid = questions.offstreetTargetBuilding(scene);
      const b = scene.buildings.find((x) => x.id === bid);
      const home = oracle.nearestStreetName(scene, b.centroid);
      L.push(`${bid}'s home street (nearest): ${home}`);
      for (const c of closures(scene)) {
        const s = oracle.nearestStreetName(scene, c.position);
        const d = geo.haversineMeters(b.centroid, c.position);
        L.push(`${c.id}: nearest street ${s}${s === home ? " (home)" : ""}, ${d.toFixed(1)}m from ${bid}`);
      }
      break;
    }
    default:
      break;
  }
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// v2 DIVERSITY: paraphrase variants per question (the narrowing fix). idx 0 is
// the canonical prompt; idx>0 are rewordings that preserve the SAME embedded
// scene ids and meaning, so "read the textmap" becomes phrasing-invariant.
// ---------------------------------------------------------------------------
const PARAPHRASES = {
  containment: (s) => [
    "Which equipment items sit INSIDE a building footprint? List their ids in `equipmentIds` (empty array if none).",
    "Report every equipment id whose point falls within a building's footprint. Fill `equipmentIds` (empty array if none).",
    "Find all equipment located inside building footprints and list their ids in `equipmentIds` (empty if none).",
  ],
  crossing: (s) => [
    "Which cables pass THROUGH a building they do not terminate at? List their ids in `cableIds` (empty array if none).",
    "Report every cable whose path crosses a foreign building footprint (not its own endpoints). Fill `cableIds` (empty if none).",
    "List the ids of cables that intersect a building's interior other than their source/target, in `cableIds` (empty if none).",
  ],
  onstreet: (s) => {
    const id = questions.firstClosureId(s);
    return [
      `Does equipment ${id} sit on a street (within ~8m of a street centerline) rather than off-street or inside a building? Fill \`onStreet\` (true/false).`,
      `Is ${id} located on the street — i.e. within about 8m of a street centerline? Report \`onStreet\` as true or false.`,
      `Determine whether ${id} is street-placed (≤~8m from a centerline). Fill \`onStreet\` (true/false).`,
    ];
  },
  nearest: (s) => {
    const b = s.buildings[0].id;
    return [
      `Which closure is geographically closest to building ${b}? Fill \`closureId\` with its id.`,
      `Find the nearest closure to building ${b} and put its id in \`closureId\`.`,
      `Report the closure with the smallest distance to ${b}'s centroid in \`closureId\`.`,
    ];
  },
  coverage_gap: (s) => [
    "Is any building left without a closure within 35m of it? List every such building in `buildingIds` (empty array if none).",
    "Find buildings that have NO closure inside a 35m radius (coverage gaps). Fill `buildingIds` (empty if none).",
    "Which buildings' nearest closure is farther than 35m away? List their ids in `buildingIds` (empty if none).",
  ],
  topology: (s) => {
    const b = questions.topologyBuilding(s);
    return [
      `Trace the equipment on the path from building ${b} to the source (CO), nearest-first. Fill \`equipmentPath\` with the ordered ids.`,
      `From building ${b}, list the equipment back to the CO in order (closest first) in \`equipmentPath\`.`,
      `What is the ordered chain of equipment linking ${b} to the network source? Fill \`equipmentPath\` nearest-first.`,
    ];
  },
  blockage: (s) => {
    const co = questions.coEquip(s);
    const t = questions.blockageTarget(s);
    return [
      `A straight cable runs from ${co?.id ?? "CO-1"} to building ${t.id}. Which OTHER buildings' footprints does it pass through? Fill \`buildingIds\` (exclude ${t.id}; empty if none).`,
      `Draw the straight line ${co?.id ?? "CO-1"}→${t.id}; list every building (besides ${t.id}) it crosses in \`buildingIds\` (empty if none).`,
      `Which buildings block the direct segment from ${co?.id ?? "CO-1"} to ${t.id}? List their ids in \`buildingIds\`, excluding ${t.id} (empty if none).`,
    ];
  },
  road_misplacement: (s) => [
    "Which equipment (excluding the CO) is misplaced into a carriageway — within ~5m of a street centerline? List their ids in `equipmentIds` (empty if none).",
    "Report equipment sitting in the road (≤~5m from a centerline), excluding the central office. Fill `equipmentIds` (empty if none).",
    "Find equipment placed on the roadway rather than a verge/sidewalk. List ids in `equipmentIds`, excluding the CO (empty if none).",
  ],
  enclosure: (s) => [
    "Which buildings lie in the INTERIOR of the cluster (centroid not on the convex hull)? List them in `buildingIds` (empty if none).",
    "Report buildings whose centroids are NOT on the outer perimeter (convex hull) of the cluster. Fill `buildingIds` (empty if none).",
    "Find the interior buildings — those not on the hull of all centroids. List ids in `buildingIds` (empty if none).",
  ],
  nearest_offstreet: (s) => {
    const b = questions.offstreetTargetBuilding(s);
    return [
      `Building ${b}'s home street is the street nearest it. Which closure is nearest ${b} among closures whose own nearest street DIFFERS from ${b}'s home street? Fill \`closureId\` ('none' if all share the home street).`,
      `Considering ${b}, find the closest closure that sits on a DIFFERENT street than ${b}'s nearest street. Report its id in \`closureId\` ('none' if none).`,
      `Which closure — off ${b}'s home street — is nearest to ${b}? Fill \`closureId\`, or 'none' if every closure is on the home street.`,
    ];
  },
};

// Returns the prompt text for a given question + variant index (0 = canonical).
function promptVariant(q, scene, idx) {
  if (idx === 0 || !PARAPHRASES[q.id]) return q.prompt(scene);
  const vs = PARAPHRASES[q.id](scene);
  return vs[(idx - 1) % vs.length];
}

// ---------------------------------------------------------------------------
// v2 TOOL-CALL TRACES (the ceiling-raiser): for compute-bound categories the
// assistant emits a geometry-tool CALL, the executor's exact RESULT, then the
// answer — distilling the executor into the weights (OptiMind solver-parity).
// Coordinates come from the scene in meters (x,y from SW), matching the rings
// the model sees in the textmap FOOTPRINTS section.
// ---------------------------------------------------------------------------
const TOOL_CATS = new Set(["crossing", "line-intersection", "mixed"]);
const xM = (s, c) => Math.round(geo.haversineMeters([s.bounds.minLng, c[1]], [c[0], c[1]]));
const yM = (s, c) => Math.round(geo.haversineMeters([c[0], s.bounds.minLat], [c[0], c[1]]));
const ringM = (s, b) => b.footprint.map((c) => [xM(s, c), yM(s, c)]);

function toolTrace(qid, scene, answer) {
  const calls = [];
  const results = [];
  if (qid === "blockage") {
    const co = questions.coEquip(scene);
    const t = questions.blockageTarget(scene);
    if (!co) return null;
    const a = [xM(scene, co.position), yM(scene, co.position)];
    const b = [xM(scene, t.centroid), yM(scene, t.centroid)];
    const rings = {};
    for (const bl of scene.buildings) if (bl.id !== t.id) rings[bl.id] = ringM(scene, bl);
    calls.push(JSON.stringify({ op: "segment_intersects_polygon", units: "m", a, b, rings }));
    results.push(`segment_intersects_polygon = intersects: [${(answer.buildingIds ?? []).join(", ")}]`);
  } else if (qid === "crossing") {
    for (const c of scene.cables) {
      const a = [xM(scene, c.path[0]), yM(scene, c.path[0])];
      const b = [xM(scene, c.path[c.path.length - 1]), yM(scene, c.path[c.path.length - 1])];
      const rings = {};
      for (const bl of scene.buildings) if (bl.id !== c.sourceId && bl.id !== c.targetId) rings[bl.id] = ringM(scene, bl);
      const hit = (answer.cableIds ?? []).includes(c.id);
      calls.push(JSON.stringify({ op: "segment_intersects_polygon", units: "m", a, b, rings, note: c.id }));
      results.push(`${c.id}: ${hit ? "crosses a foreign building" : "clear"}`);
    }
  } else if (qid === "enclosure") {
    const pts = {};
    for (const b of scene.buildings) pts[b.id] = [xM(scene, b.centroid), yM(scene, b.centroid)];
    calls.push(JSON.stringify({ op: "convex_hull", units: "m", points: pts }));
    results.push(`convex_hull -> interior: [${(answer.buildingIds ?? []).join(", ")}]`);
  } else {
    return null;
  }
  return `TOOL_CALLS:\n${calls.join("\n")}\n\nTOOL_RESULTS:\n${results.join("\n")}`;
}

// ---------------------------------------------------------------------------
const SYSTEM =
  "You are a precise spatial-analysis assistant for GIS / FTTH network data. " +
  "You are given a representation of a small map (buildings, streets, equipment, cables) and ONE question. " +
  "First write an EXTRACTION: section listing the facts relevant to the question, exactly as they appear in the representation. " +
  "Then output your final line as: ANSWER: {json object with ONLY the requested field(s)}. " +
  "Ids must match exactly the ids present in the data. Do not invent ids.";

async function fetchScene(body) {
  const r = await fetch(`${url}/api/experiments/repr-eval/sft-scene`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(secret ? { "x-eval-secret": secret } : {}) },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`sft-scene ${r.status}: ${await r.text()}`);
  return (await r.json()).scene;
}

async function main() {
  const CORE = questions.QUESTIONS; // hold-outs (ALL_QUESTIONS) deliberately not used
  const rows = [];
  let gradeFails = 0;
  const specs = [
    ...Array.from({ length: N_SYNTH }, (_, i) => ({
      seed: SYNTH_BASE + i,
      source: "synthetic",
      blocks: 2 + (i % 3), // 2..4 — size variety
    })),
    ...Array.from({ length: N_REAL }, (_, i) => ({ seed: REAL_BASE + i, source: "real", city: "nyc" })),
  ];

  let done = 0;
  for (const spec of specs) {
    let scene;
    try {
      scene = await fetchScene(spec);
    } catch (e) {
      console.error(`skip seed ${spec.seed}: ${e.message}`);
      continue;
    }
    const tmOpts = { zoom: 1, feeds: V2_FEEDS, rings: V2_RINGS };
    const reps = { textmap2: toTextMapV2(scene, tmOpts), json: toJSON(scene) };
    for (const q of CORE) {
      const answer = oracleAnswer(q.id, scene);
      // Self-check: the oracle answer MUST grade correct — a label that fails
      // its own grader would poison training.
      if (!q.grade(scene, answer)) {
        gradeFails++;
        continue;
      }
      const tr = trace(q.id, scene);
      // v2: tool-call block for compute-bound categories (distills the executor).
      const tools = V2_TOOLS && TOOL_CATS.has(q.category) ? toolTrace(q.id, scene, answer) : null;
      // v2 error-loop: oversample the categories v1 was weak on.
      const reps_for_cat = V2_TOOLS && TOOL_CATS.has(q.category) ? 2 : 1;
      const assistant = tools
        ? `EXTRACTION:\n${tr}\n\n${tools}\n\nANSWER: ${JSON.stringify(answer)}`
        : `EXTRACTION:\n${tr}\n\nANSWER: ${JSON.stringify(answer)}`;
      for (let rep = 0; rep < reps_for_cat; rep++) {
        for (let v = 0; v < VARIANTS; v++) {
          const promptText = promptVariant(q, scene, (rep + v) % Math.max(1, VARIANTS));
          for (const arm of ["textmap2", "json"]) {
            const hint = hintFor(q.id, arm);
            rows.push({
              messages: [
                { role: "system", content: SYSTEM },
                { role: "user", content: `${reps[arm]}\n\nQUESTION:\n${promptText}${hint}` },
                { role: "assistant", content: assistant },
              ],
            });
          }
        }
      }
    }
    done++;
    if (done % 25 === 0) console.log(`${done}/${specs.length} scenes`);
  }

  // Deterministic shuffle (LCG) so formats/categories interleave.
  let s = 1234567;
  const rand = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = rows.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [rows[i], rows[j]] = [rows[j], rows[i]];
  }
  const val = rows.filter((_, i) => i % 50 === 0);
  const train = rows.filter((_, i) => i % 50 !== 0);

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(`${OUT_DIR}/train.jsonl`, train.map((r) => JSON.stringify(r)).join("\n"), "utf8");
  writeFileSync(`${OUT_DIR}/val.jsonl`, val.map((r) => JSON.stringify(r)).join("\n"), "utf8");

  const chars = rows.reduce((n, r) => n + r.messages.reduce((m, x) => m + x.content.length, 0), 0);
  console.log(`\nscenes ok: ${done}/${specs.length}  grade-fails skipped: ${gradeFails}`);
  console.log(`examples: train ${train.length} + val ${val.length}`);
  console.log(`~${Math.round(chars / 4 / 1e6)}M tokens (chars/4 estimate)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
