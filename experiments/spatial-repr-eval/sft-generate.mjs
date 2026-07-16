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
const secret = process.env.EVAL_SECRET ?? "";

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
      seed: 50000 + i,
      source: "synthetic",
      blocks: 2 + (i % 3), // 2..4 — size variety
    })),
    ...Array.from({ length: N_REAL }, (_, i) => ({ seed: 51000 + i, source: "real", city: "nyc" })),
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
    const reps = { textmap2: toTextMapV2(scene, { zoom: 1 }), json: toJSON(scene) };
    for (const q of CORE) {
      const answer = oracleAnswer(q.id, scene);
      // Self-check: the oracle answer MUST grade correct — a label that fails
      // its own grader would poison training.
      if (!q.grade(scene, answer)) {
        gradeFails++;
        continue;
      }
      const tr = trace(q.id, scene);
      for (const arm of ["textmap2", "json"]) {
        const hint = hintFor(q.id, arm);
        rows.push({
          messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: `${reps[arm]}\n\nQUESTION:\n${q.prompt(scene)}${hint}` },
            { role: "assistant", content: `EXTRACTION:\n${tr}\n\nANSWER: ${JSON.stringify(answer)}` },
          ],
        });
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

  mkdirSync("sft-data", { recursive: true });
  writeFileSync("sft-data/train.jsonl", train.map((r) => JSON.stringify(r)).join("\n"), "utf8");
  writeFileSync("sft-data/val.jsonl", val.map((r) => JSON.stringify(r)).join("\n"), "utf8");

  const chars = rows.reduce((n, r) => n + r.messages.reduce((m, x) => m + x.content.length, 0), 0);
  console.log(`\nscenes ok: ${done}/${specs.length}  grade-fails skipped: ${gradeFails}`);
  console.log(`examples: train ${train.length} + val ${val.length}`);
  console.log(`~${Math.round(chars / 4 / 1e6)}M tokens (chars/4 estimate)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
