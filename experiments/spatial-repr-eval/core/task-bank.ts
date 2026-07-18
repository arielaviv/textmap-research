/**
 * Task-family bank for SFT v2 (prereg E2 revision, Defect B fix).
 *
 * v1 trained 10 question types with 3 paraphrases each — input-side variety
 * only. Its hold-out gap was +0 because the hold-out types emit OUTPUT SCHEMAS
 * (count / direction / quadrant / ordered ids) the model never produced. This
 * bank fixes that with ~30 trained families over >300 unique templates and a
 * spread of output shapes ({count}, {meters}, {direction}, {quadrant},
 * {street}, {sameStreet}, {onHull}, {endpoints}, ordered id lists), all
 * composed from the SAME scene primitives — no new oracle semantics leak into
 * the held-out set.
 *
 * HELD OUT (never generated here, reserved for the generalization eval):
 * the six ho_* questions of questions.ts plus four reserved family names —
 * farthest_closure, count_crossing, mid_between_closures, same_side_street.
 * Hold-out is by WHOLE FAMILY, not by phrasing.
 *
 * Compute families carry TOOL_CALLS the generator executes with the real
 * executor (geo-tools). INTEGRITY: calls are marshaled from the scene the same
 * way a correct model would read them (meter frame = the textmap legend's
 * x=/y=); the answer in the trace is derived FROM the executor's output, and
 * the generator asserts it agrees with the oracle — disagreements (rounding at
 * a boundary) skip the example rather than training on a poisoned label.
 */

import { orderedEqual, setEqual } from "./grade";
import { haversineMeters, pointInPolygon } from "./geo";
import {
  cablesCrossingForeignBuildings,
  closuresInsideBuildings,
  coverageGapBuildings,
  distanceToNearestStreet,
  equipmentInRoad,
  interiorBuildings,
  isOnStreet,
  lineCrossesBuildings,
  nearestClosureOffStreet,
  nearestClosureToBuilding,
  nearestStreetName,
  ORACLE_CONSTANTS,
  pathToSource,
} from "./oracle";
import {
  blockageTarget,
  coEquip,
  firstClosureId,
  offstreetTargetBuilding,
  topologyBuilding,
} from "./questions";
import type { Scene, SceneBuilding, SceneEquipment } from "./scene";

/** One generated example, before arms/skins are applied by the generator. */
export interface BankExample {
  prompt: string;
  /** EXTRACTION body — true facts / marshaled inputs, NEVER the conclusion
   *  for compute families (the conclusion lives after TOOL_RESULTS). */
  extraction: string;
  /** Final answer object (the label). */
  answer: Record<string, unknown>;
  /** Compute families: JSON tool lines (meter frame). */
  toolCalls?: string[];
  /** Compute families: derive the post-tool assistant body (a short
   *  derivation line; the generator appends the ANSWER line). Receives the
   *  REAL executor output for `toolCalls`. Return null if the executor output
   *  contradicts the expected answer (example is skipped). */
  conclude?: (toolResults: string) => string | null;
}

export interface TaskFamily {
  id: string;
  kind: "read" | "compute";
  /** Number of distinct templates (for the >300 manifest assert). */
  templateCount: number;
  /** Build one example, or null when the scene can't host the family
   *  (degenerate margin / missing entities). rand ∈ [0,1). */
  build: (scene: Scene, rand: () => number) => BankExample | null;
}

// ---------------------------------------------------------------------------
// Shared helpers (meter frame = textmap legend x=/y=: meters from the SW corner)
// ---------------------------------------------------------------------------
const xM = (s: Scene, c: [number, number]) =>
  Math.round(haversineMeters([s.bounds.minLng, c[1]], [c[0], c[1]]));
const yM = (s: Scene, c: [number, number]) =>
  Math.round(haversineMeters([c[0], s.bounds.minLat], [c[0], c[1]]));
const ptM = (s: Scene, c: [number, number]): [number, number] => [xM(s, c), yM(s, c)];
const ringM = (s: Scene, b: SceneBuilding) => b.footprint.map((c) => ptM(s, c));
const closuresOf = (s: Scene) => s.equipment.filter((e) => e.kind === "closure");
const pick = <T>(arr: T[], rand: () => number): T => arr[Math.floor(rand() * arr.length) % arr.length];
const tpl = (templates: ((...a: string[]) => string)[], rand: () => number) => pick(templates, rand);
const fmt = (n: number) => n.toFixed(1);

/** Streets named per the oracle key (null → placeholder streets excluded). */
const streetOf = (s: Scene, pos: [number, number]) => nearestStreetName(s, pos);

// Result parsers (must match geo-tools output formats exactly).
const parseCrossings = (results: string): Map<string, string[]> => {
  const m = new Map<string, string[]>();
  for (const g of results.matchAll(/([\w-]+) -> crosses: \[([^\]]*)\]/g)) {
    m.set(g[1], g[2] ? g[2].split(",").map((x) => x.trim()).filter(Boolean) : []);
  }
  return m;
};
const parseInterior = (results: string): string[] | null => {
  const g = results.match(/interior: \[([^\]]*)\]/);
  if (!g) return null;
  return g[1] ? g[1].split(",").map((x) => x.trim()).filter(Boolean) : [];
};
const parseFilter = (results: string): { pass: string[]; fail: string[] } | null => {
  const g = results.match(/\{"pass":.*"n_pass":\d+\}/);
  if (!g) return null;
  try {
    const o = JSON.parse(g[0]) as { pass: string[]; fail: string[] };
    return { pass: o.pass, fail: o.fail };
  } catch {
    return null;
  }
};
const parseNearest = (results: string): string | null => {
  const g = results.match(/nearest:([\w-]+)/);
  return g ? g[1] : null;
};
const parseRanked = (results: string): { id: string; d: number }[] => {
  const out: { id: string; d: number }[] = [];
  for (const g of results.matchAll(/([\w-]+)\(([^)]*)\)=([\d.]+)/g)) {
    out.push({ id: g[1], d: Number(g[3]) });
  }
  return out;
};
const parseDist = (results: string): number | null => {
  const g = results.match(/dist[^=]*= ([\d.]+)m/);
  return g ? Number(g[1]) : null;
};

// ---------------------------------------------------------------------------
// CORE 10 — the frozen protocol families, with expanded paraphrase sets and
// v2-pipeline tool traces (reducer ops, inputs-only extractions).
// ---------------------------------------------------------------------------

const T_CONTAINMENT = [
  () => "List the ids of every equipment item whose point lies INSIDE a building footprint. Fill `equipmentIds` (empty array if none).",
  () => "Which equipment items sit INSIDE a building footprint? List their ids in `equipmentIds` (empty array if none).",
  () => "Report every equipment id whose point falls within a building's footprint. Fill `equipmentIds` (empty array if none).",
  () => "Find all equipment located inside building footprints and list their ids in `equipmentIds` (empty if none).",
  () => "Identify equipment placed within any building's outline. Fill `equipmentIds` with their ids (empty array if none).",
  () => "Is any equipment item inside a building? List every such id in `equipmentIds` (empty array if none).",
  () => "Give the ids of equipment whose location is contained by a building footprint, in `equipmentIds` (empty if none).",
  () => "Which equipment, if any, is enclosed by a building's footprint polygon? Fill `equipmentIds` (empty array if none).",
  () => "Scan every equipment item and report the ones inside a building outline. Fill `equipmentIds` (empty if none).",
  () => "List in `equipmentIds` each equipment item located within a building's walls (empty array if none).",
  () => "Check all equipment against all building footprints; return the contained ones in `equipmentIds` (empty if none).",
];

const T_CROSSING = [
  () => "List the ids of every cable whose path passes THROUGH a building footprint it does not terminate at. Fill `cableIds` (empty array if none).",
  () => "Which cables pass THROUGH a building they do not terminate at? List their ids in `cableIds` (empty array if none).",
  () => "Report every cable whose path crosses a foreign building footprint (not its own endpoints). Fill `cableIds` (empty if none).",
  () => "List the ids of cables that intersect a building's interior other than their source/target, in `cableIds` (empty if none).",
  () => "Find cables that cut through buildings they neither start nor end at. Fill `cableIds` (empty array if none).",
  () => "Which cable runs violate a building it does not serve (passes through its footprint)? Fill `cableIds` (empty if none).",
  () => "Identify every cable crossing a third-party building footprint. List ids in `cableIds` (empty array if none).",
  () => "Do any cables pass through buildings other than their endpoints? List them in `cableIds` (empty if none).",
  () => "Report cables whose geometry enters a non-terminal building. Fill `cableIds` (empty array if none).",
  () => "Check each cable against every building it does not terminate at; list crossers in `cableIds` (empty if none).",
  () => "Which cables conflict with building footprints along their path (excluding their own endpoints)? Fill `cableIds` (empty if none).",
];

const T_ONSTREET = [
  (id: string) => `Is equipment ${id} placed on a street (within ~8m of a street centerline), as opposed to off-street / inside a building? Fill \`onStreet\` (true/false).`,
  (id: string) => `Does equipment ${id} sit on a street (within ~8m of a street centerline) rather than off-street or inside a building? Fill \`onStreet\` (true/false).`,
  (id: string) => `Is ${id} located on the street — i.e. within about 8m of a street centerline? Report \`onStreet\` as true or false.`,
  (id: string) => `Determine whether ${id} is street-placed (≤~8m from a centerline). Fill \`onStreet\` (true/false).`,
  (id: string) => `Would you classify ${id}'s placement as on-street (within ~8m of a centerline)? Fill \`onStreet\`.`,
  (id: string) => `Check ${id}: does it stand within roughly 8 meters of a street centerline? Answer in \`onStreet\` (true/false).`,
  (id: string) => `Is the position of ${id} on a street corridor (≤~8m from the centerline)? Fill \`onStreet\` (true/false).`,
  (id: string) => `Evaluate ${id}'s placement: on-street (within ~8m of a centerline) or not? Fill \`onStreet\`.`,
  (id: string) => `Report whether ${id} lies within ~8m of any street centerline in \`onStreet\` (true/false).`,
  (id: string) => `From its measured distance to the nearest street, is ${id} on-street (≤~8m)? Fill \`onStreet\`.`,
  (id: string) => `Decide for ${id}: street placement (within ~8m of a centerline) — true or false? Fill \`onStreet\`.`,
];

const T_NEAREST = [
  (b: string) => `Which closure is geographically nearest to building ${b}? Fill \`closureId\` with its id.`,
  (b: string) => `Find the nearest closure to building ${b} and put its id in \`closureId\`.`,
  (b: string) => `Report the closure with the smallest distance to ${b}'s centroid in \`closureId\`.`,
  (b: string) => `Of all closures, which one is closest to ${b}? Fill \`closureId\`.`,
  (b: string) => `Identify the minimum-distance closure from building ${b}. Fill \`closureId\` with its id.`,
  (b: string) => `Which closure would a crew reach first from ${b} (straight-line nearest)? Fill \`closureId\`.`,
  (b: string) => `Give the id of the closure nearest to ${b} in \`closureId\`.`,
  (b: string) => `Determine ${b}'s nearest closure and fill \`closureId\`.`,
  (b: string) => `Rank closures by distance from ${b}; return the nearest one's id in \`closureId\`.`,
  (b: string) => `From ${b}'s position, which closure is the shortest distance away? Fill \`closureId\`.`,
  (b: string) => `Select the closure at minimal straight-line distance from building ${b}. Fill \`closureId\`.`,
];

const T_COVERAGE = [
  () => "Is there any building with NO closure within 35m of it (a coverage gap)? Fill `buildingIds` with every such building (empty array if none).",
  () => "Is any building left without a closure within 35m of it? List every such building in `buildingIds` (empty array if none).",
  () => "Find buildings that have NO closure inside a 35m radius (coverage gaps). Fill `buildingIds` (empty if none).",
  () => "Which buildings' nearest closure is farther than 35m away? List their ids in `buildingIds` (empty if none).",
  () => "Report every building lacking closure coverage within 35m. Fill `buildingIds` (empty array if none).",
  () => "Identify coverage gaps: buildings with no closure inside 35m. Fill `buildingIds` (empty if none).",
  () => "List each building whose closest closure is beyond 35m in `buildingIds` (empty array if none).",
  () => "Are all buildings covered by a closure within 35m? List the uncovered ones in `buildingIds` (empty if none).",
  () => "Which buildings sit outside every closure's 35m radius? Fill `buildingIds` (empty array if none).",
  () => "Audit closure coverage: report buildings with none within 35m in `buildingIds` (empty if none).",
  () => "Fill `buildingIds` with every building more than 35m from its nearest closure (empty array if none).",
];

const T_TOPOLOGY = [
  (b: string) => `List the equipment on the path from building ${b} to the source (the CO), nearest-first. Fill \`equipmentPath\` with the ordered ids.`,
  (b: string) => `Trace the equipment on the path from building ${b} to the source (CO), nearest-first. Fill \`equipmentPath\` with the ordered ids.`,
  (b: string) => `From building ${b}, list the equipment back to the CO in order (closest first) in \`equipmentPath\`.`,
  (b: string) => `What is the ordered chain of equipment linking ${b} to the network source? Fill \`equipmentPath\` nearest-first.`,
  (b: string) => `Walk the serving chain from ${b} up to the source. Fill \`equipmentPath\` with the equipment ids, nearest-first.`,
  (b: string) => `Give the homing path for ${b}: serving equipment first, source last. Fill \`equipmentPath\`.`,
  (b: string) => `Which equipment connects ${b} to the source, and in what order (nearest first)? Fill \`equipmentPath\`.`,
  (b: string) => `Order the equipment between ${b} and the CO, starting at ${b}'s serving device. Fill \`equipmentPath\`.`,
  (b: string) => `Fill \`equipmentPath\` with the equipment chain from ${b} to the source, nearest-first.`,
  (b: string) => `Starting at ${b}, list each upstream equipment id in order until the source. Fill \`equipmentPath\`.`,
  (b: string) => `Report ${b}'s upstream path as ordered equipment ids (serving device first, source last) in \`equipmentPath\`.`,
];

const T_BLOCKAGE = [
  (co: string, t: string) => `If a straight cable runs from ${co} to building ${t}, list the ids of every OTHER building whose footprint the straight line passes through (exclude ${t}). Fill \`buildingIds\` (empty array if none).`,
  (co: string, t: string) => `A straight cable runs from ${co} to building ${t}. Which OTHER buildings' footprints does it pass through? Fill \`buildingIds\` (exclude ${t}; empty if none).`,
  (co: string, t: string) => `Draw the straight line ${co}→${t}; list every building (besides ${t}) it crosses in \`buildingIds\` (empty if none).`,
  (co: string, t: string) => `Which buildings block the direct segment from ${co} to ${t}? List their ids in \`buildingIds\`, excluding ${t} (empty if none).`,
  (co: string, t: string) => `Test the straight segment ${co}→${t} against every other building footprint. Fill \`buildingIds\` with the intersected ones (exclude ${t}; empty if none).`,
  (co: string, t: string) => `Along the direct route ${co} to ${t}, which building footprints are in the way (other than ${t})? Fill \`buildingIds\` (empty if none).`,
  (co: string, t: string) => `Would a straight run ${co}→${t} pass through any third building? List them in \`buildingIds\` (exclude ${t}; empty array if none).`,
  (co: string, t: string) => `Report every building whose footprint intersects segment ${co}→${t}, excluding ${t} itself. Fill \`buildingIds\` (empty if none).`,
  (co: string, t: string) => `Check the ${co}-to-${t} chord for building conflicts (excluding ${t}). Fill \`buildingIds\` (empty array if none).`,
  (co: string, t: string) => `List obstructing buildings on the straight path ${co}→${t} in \`buildingIds\` (exclude ${t}; empty if none).`,
  (co: string, t: string) => `Which footprints does the line from ${co} to ${t} cut through, besides ${t}? Fill \`buildingIds\` (empty if none).`,
];

const T_ROAD = [
  () => `Some equipment may be misplaced INTO a road — within ~${ORACLE_CONSTANTS.IN_ROAD_M}m of a street centerline (in the carriageway) instead of on a sidewalk or verge. List the ids of every such equipment item (exclude the central office). Fill \`equipmentIds\` (empty array if none).`,
  () => `Which equipment (excluding the CO) is misplaced into a carriageway — within ~${ORACLE_CONSTANTS.IN_ROAD_M}m of a street centerline? List their ids in \`equipmentIds\` (empty if none).`,
  () => `Report equipment sitting in the road (≤~${ORACLE_CONSTANTS.IN_ROAD_M}m from a centerline), excluding the central office. Fill \`equipmentIds\` (empty if none).`,
  () => `Find equipment placed on the roadway rather than a verge/sidewalk (within ~${ORACLE_CONSTANTS.IN_ROAD_M}m of a centerline; exclude the CO). List ids in \`equipmentIds\` (empty if none).`,
  () => `Audit placements: which equipment (not the CO) stands within ~${ORACLE_CONSTANTS.IN_ROAD_M}m of a street centerline, i.e. in the carriageway? Fill \`equipmentIds\` (empty if none).`,
  () => `Is any equipment (excluding the CO) inside the roadway — closer than ~${ORACLE_CONSTANTS.IN_ROAD_M}m to a centerline? Fill \`equipmentIds\` (empty array if none).`,
  () => `Flag road-misplaced equipment: distance to nearest centerline ≤~${ORACLE_CONSTANTS.IN_ROAD_M}m (CO excluded). Fill \`equipmentIds\` (empty if none).`,
  () => `List every non-CO equipment item whose centerline distance is within ~${ORACLE_CONSTANTS.IN_ROAD_M}m (in the road) in \`equipmentIds\` (empty if none).`,
  () => `Which items (excluding the central office) are dangerously in the carriageway (≤~${ORACLE_CONSTANTS.IN_ROAD_M}m from a centerline)? Fill \`equipmentIds\` (empty if none).`,
  () => `Check each equipment item's distance to the nearest street centerline; report the ones at ≤~${ORACLE_CONSTANTS.IN_ROAD_M}m (exclude the CO) in \`equipmentIds\` (empty if none).`,
  () => `Return in \`equipmentIds\` all equipment (CO excluded) located within ~${ORACLE_CONSTANTS.IN_ROAD_M}m of a street centerline (empty array if none).`,
];

const T_ENCLOSURE = [
  () => "List the ids of every building in the INTERIOR of the cluster — its centroid is NOT on the outer perimeter (convex hull) of the buildings. Fill `buildingIds` (empty array if none).",
  () => "Which buildings lie in the INTERIOR of the cluster (centroid not on the convex hull)? List them in `buildingIds` (empty if none).",
  () => "Report buildings whose centroids are NOT on the outer perimeter (convex hull) of the cluster. Fill `buildingIds` (empty if none).",
  () => "Find the interior buildings — those not on the hull of all centroids. List ids in `buildingIds` (empty if none).",
  () => "Which building centroids are strictly inside the convex hull of all centroids? Fill `buildingIds` (empty array if none).",
  () => "Identify buildings enclosed by the cluster's outer ring (not hull vertices). Fill `buildingIds` (empty if none).",
  () => "Compute the convex hull of building centroids; list the NON-hull buildings in `buildingIds` (empty if none).",
  () => "Which buildings are surrounded — their centroid is interior to the hull of the cluster? Fill `buildingIds` (empty if none).",
  () => "List in `buildingIds` every building whose centroid is not a vertex of the cluster's convex hull (empty if none).",
  () => "Are any buildings fully inside the cluster's outer boundary (hull)? Report them in `buildingIds` (empty array if none).",
  () => "Separate hull buildings from interior ones; fill `buildingIds` with the interior set (empty if none).",
];

const T_OFFSTREET = [
  (t: string) => `Consider building ${t}. Its "home street" is the street nearest to it. Which closure is nearest to ${t} among the closures whose OWN nearest street is a DIFFERENT street than ${t}'s home street? Fill \`closureId\` with its id, or 'none' if every closure sits on the home street.`,
  (t: string) => `Building ${t}'s home street is the street nearest it. Which closure is nearest ${t} among closures whose own nearest street DIFFERS from ${t}'s home street? Fill \`closureId\` ('none' if all share the home street).`,
  (t: string) => `Considering ${t}, find the closest closure that sits on a DIFFERENT street than ${t}'s nearest street. Report its id in \`closureId\` ('none' if none).`,
  (t: string) => `Which closure — off ${t}'s home street — is nearest to ${t}? Fill \`closureId\`, or 'none' if every closure is on the home street.`,
  (t: string) => `Take ${t}'s nearest street as its home street. Among closures on OTHER streets, which is closest to ${t}? Fill \`closureId\` ('none' if there are none).`,
  (t: string) => `Exclude every closure on ${t}'s home street (its nearest street); of the rest, which is nearest ${t}? Fill \`closureId\` ('none' if empty).`,
  (t: string) => `Find ${t}'s nearest off-home-street closure: candidates are closures whose nearest street differs from ${t}'s. Fill \`closureId\` ('none' if all match).`,
  (t: string) => `For building ${t}: nearest closure NOT on its home street (the street nearest ${t})? Fill \`closureId\` or 'none'.`,
  (t: string) => `Filter closures to those on a different street than ${t}'s nearest street, then pick the one closest to ${t}. Fill \`closureId\` ('none' if no candidates).`,
  (t: string) => `Which is the minimum-distance closure from ${t} once closures sharing ${t}'s home street are removed? Fill \`closureId\` ('none' if none remain).`,
  (t: string) => `Determine ${t}'s home street, drop closures on it, and report the nearest remaining closure in \`closureId\` ('none' if empty).`,
];

// ---------------------------------------------------------------------------
// NEW READ FAMILIES
// ---------------------------------------------------------------------------

const T_COUNT_KIND = [
  (k: string) => `How many ${k} are there in this scene? Fill \`count\` with the number.`,
  (k: string) => `Count the ${k} in the map. Fill \`count\`.`,
  (k: string) => `What is the total number of ${k}? Fill \`count\` with the number.`,
  (k: string) => `Report how many ${k} the representation contains in \`count\`.`,
  (k: string) => `Tally the ${k}: how many are present? Fill \`count\`.`,
  (k: string) => `Give the number of ${k} in this scene in \`count\`.`,
  (k: string) => `How many distinct ${k} does the map show? Fill \`count\`.`,
  (k: string) => `Enumerate the ${k} and report their total in \`count\`.`,
  (k: string) => `Fill \`count\` with the number of ${k} in the data.`,
  (k: string) => `State the count of ${k} present in \`count\`.`,
];

const T_COUNT_ON_STREET = [
  (st: string) => `How many closures have "${st}" as their nearest street? Fill \`count\` with the number.`,
  (st: string) => `Count the closures whose nearest street is "${st}". Fill \`count\`.`,
  (st: string) => `How many closures are associated with "${st}" (their nearest street)? Fill \`count\`.`,
  (st: string) => `Report in \`count\` the number of closures whose nearest street is "${st}".`,
  (st: string) => `Of all closures, how many sit nearest to "${st}"? Fill \`count\`.`,
  (st: string) => `Tally closures by nearest street: how many map to "${st}"? Fill \`count\`.`,
  (st: string) => `Fill \`count\` with how many closures have nearest street "${st}".`,
  (st: string) => `For street "${st}": how many closures is it the nearest street of? Fill \`count\`.`,
  (st: string) => `Give the number of closures whose closest street is "${st}" in \`count\`.`,
  (st: string) => `How many of the closures list "${st}" as their nearest street? Fill \`count\`.`,
];

const T_STREET_OF = [
  (b: string) => `What is the nearest street to building ${b} (its home street)? Fill \`street\` with the street name.`,
  (b: string) => `Name building ${b}'s home street — the street nearest to it. Fill \`street\`.`,
  (b: string) => `Which street is closest to ${b}? Fill \`street\` with its name.`,
  (b: string) => `Report ${b}'s nearest street name in \`street\`.`,
  (b: string) => `Identify the street nearest building ${b} and fill \`street\`.`,
  (b: string) => `What street does ${b} front onto (nearest street)? Fill \`street\`.`,
  (b: string) => `Fill \`street\` with the name of the street nearest to ${b}.`,
  (b: string) => `Determine the home street (nearest street) of ${b}. Fill \`street\`.`,
  (b: string) => `Give ${b}'s closest street by name in \`street\`.`,
  (b: string) => `Which named street lies nearest to building ${b}? Fill \`street\`.`,
];

const T_SAME_STREET = [
  (a: string, b: string) => `Do buildings ${a} and ${b} share the same home street (each one's nearest street)? Fill \`sameStreet\` (true/false).`,
  (a: string, b: string) => `Is the nearest street of ${a} the same street as the nearest street of ${b}? Fill \`sameStreet\` (true/false).`,
  (a: string, b: string) => `Compare home streets: ${a} vs ${b} — same street? Fill \`sameStreet\`.`,
  (a: string, b: string) => `Are ${a} and ${b} on the same street (by nearest street)? Fill \`sameStreet\` (true/false).`,
  (a: string, b: string) => `Check whether ${a} and ${b} front the same nearest street. Fill \`sameStreet\`.`,
  (a: string, b: string) => `Report in \`sameStreet\` whether ${a}'s home street equals ${b}'s (true/false).`,
  (a: string, b: string) => `Same-street test for ${a} and ${b} (nearest street each): true or false? Fill \`sameStreet\`.`,
  (a: string, b: string) => `Would ${a} and ${b} get the same street name as their nearest street? Fill \`sameStreet\`.`,
  (a: string, b: string) => `Fill \`sameStreet\` with true if ${a} and ${b} share a nearest street, else false.`,
  (a: string, b: string) => `Determine if buildings ${a} and ${b} are addressed to the same nearest street. Fill \`sameStreet\`.`,
];

const T_SERVES = [
  (c: string) => `Which building(s) does closure ${c} serve? Fill \`buildingIds\` (empty array if none).`,
  (c: string) => `List the buildings served by ${c} in \`buildingIds\` (empty if none).`,
  (c: string) => `What is ${c}'s serving list? Fill \`buildingIds\` with the building ids (empty if none).`,
  (c: string) => `Report every building id that ${c} serves in \`buildingIds\` (empty array if none).`,
  (c: string) => `Which customers (buildings) hang off closure ${c}? Fill \`buildingIds\` (empty if none).`,
  (c: string) => `Give the building ids in ${c}'s serves list in \`buildingIds\` (empty array if none).`,
  (c: string) => `Fill \`buildingIds\` with the buildings connected to ${c} (empty if none).`,
  (c: string) => `Enumerate the buildings assigned to ${c}. Fill \`buildingIds\` (empty array if none).`,
  (c: string) => `Which buildings does ${c} provide service to? List them in \`buildingIds\` (empty if none).`,
  (c: string) => `State ${c}'s served buildings in \`buildingIds\` (empty array if none).`,
];

const T_SERVED_BY = [
  (b: string) => `Which closure serves building ${b}? Fill \`closureId\` with its id, or 'none'.`,
  (b: string) => `Identify the closure whose serves list contains ${b}. Fill \`closureId\` ('none' if unserved).`,
  (b: string) => `What is ${b}'s serving closure? Fill \`closureId\` ('none' if it has none).`,
  (b: string) => `Report the closure assigned to building ${b} in \`closureId\` ('none' if unserved).`,
  (b: string) => `Which closure is ${b} connected to for service? Fill \`closureId\` or 'none'.`,
  (b: string) => `Find ${b} in the serves lists: which closure carries it? Fill \`closureId\` ('none' if absent).`,
  (b: string) => `Give the id of the closure serving ${b} in \`closureId\` ('none' if no closure serves it).`,
  (b: string) => `Fill \`closureId\` with ${b}'s serving closure ('none' if unserved).`,
  (b: string) => `Which device (closure) lists ${b} among its served buildings? Fill \`closureId\` or 'none'.`,
  (b: string) => `State the serving closure of building ${b} in \`closureId\` ('none' if there is none).`,
];

const T_ENDPOINTS = [
  (c: string) => `What does cable ${c} connect? Fill \`endpoints\` with [source id, target id] in that order.`,
  (c: string) => `Report cable ${c}'s two endpoints as [source, target] in \`endpoints\`.`,
  (c: string) => `Which two elements does ${c} link? Fill \`endpoints\` [source id first, target id second].`,
  (c: string) => `Give ${c}'s source and target ids, ordered [source, target], in \`endpoints\`.`,
  (c: string) => `Identify the endpoints of cable ${c}. Fill \`endpoints\` as [source, target].`,
  (c: string) => `From the cables data, what are ${c}'s source and target? Fill \`endpoints\` [source, target].`,
  (c: string) => `Fill \`endpoints\` with the ordered pair [source id, target id] of cable ${c}.`,
  (c: string) => `Cable ${c} runs from which element to which? Fill \`endpoints\` [source, target].`,
  (c: string) => `State the connection of ${c}: [source, target] in \`endpoints\`.`,
  (c: string) => `Look up cable ${c} and report its endpoints in order [source, target] in \`endpoints\`.`,
];

const T_DEGREE = [
  (e: string) => `How many cables attach to ${e} (as source or target)? Fill \`count\`.`,
  (e: string) => `Count the cables incident to ${e} (either endpoint). Fill \`count\`.`,
  (e: string) => `What is ${e}'s cable degree — the number of cables touching it? Fill \`count\`.`,
  (e: string) => `Report in \`count\` how many cables have ${e} as source or target.`,
  (e: string) => `How many cable connections does ${e} have? Fill \`count\`.`,
  (e: string) => `Tally the cables whose source or target is ${e}. Fill \`count\`.`,
  (e: string) => `Fill \`count\` with the number of cables incident to ${e}.`,
  (e: string) => `Give ${e}'s connection count (cables at either end) in \`count\`.`,
  (e: string) => `From the cables list, how many reference ${e}? Fill \`count\`.`,
  (e: string) => `State the number of cables attached to ${e} in \`count\`.`,
];

const T_HOPS = [
  (b: string) => `How many equipment items are on the path from building ${b} to the source, counting the serving closure and the source itself? Fill \`count\`.`,
  (b: string) => `Count the equipment on ${b}'s homing path to the CO (inclusive of both ends of the chain). Fill \`count\`.`,
  (b: string) => `What is the length (in equipment items) of the chain from ${b} to the source? Fill \`count\`.`,
  (b: string) => `Report in \`count\` the number of equipment nodes between ${b} and the source, inclusive.`,
  (b: string) => `How many devices does ${b}'s path to the source pass through (serving closure through source)? Fill \`count\`.`,
  (b: string) => `Fill \`count\` with the equipment count on the route from ${b} up to the CO (both included).`,
  (b: string) => `Give the hop count of ${b}'s upstream chain (equipment items, source included) in \`count\`.`,
  (b: string) => `Counting every equipment item from ${b}'s serving closure to the source, what is the total? Fill \`count\`.`,
  (b: string) => `How long is the equipment chain ${b} → source, in items? Fill \`count\`.`,
  (b: string) => `State in \`count\` how many equipment ids ${b}'s path to the source contains.`,
];

const T_HULL_MEMBER = [
  (b: string) => `Is building ${b} on the outer perimeter (convex hull) of the cluster's building centroids? Fill \`onHull\` (true/false).`,
  (b: string) => `Does ${b}'s centroid sit on the convex hull of all building centroids? Fill \`onHull\` (true/false).`,
  (b: string) => `Is ${b} a perimeter building of the cluster (hull vertex) rather than interior? Fill \`onHull\`.`,
  (b: string) => `Classify ${b}: on the cluster's outer hull (true) or interior (false)? Fill \`onHull\`.`,
  (b: string) => `Report whether ${b} lies on the outer boundary (convex hull) of the cluster in \`onHull\`.`,
  (b: string) => `Would the convex hull of all centroids include ${b} as a vertex? Fill \`onHull\` (true/false).`,
  (b: string) => `Fill \`onHull\` with true if ${b} is on the cluster perimeter (hull), false if interior.`,
  (b: string) => `Hull test for ${b}: perimeter or enclosed? Fill \`onHull\` (true = on hull).`,
  (b: string) => `Is ${b} one of the outermost buildings (on the hull of centroids)? Fill \`onHull\`.`,
  (b: string) => `Determine ${b}'s hull membership (centroid on the convex hull?) in \`onHull\` (true/false).`,
];

const T_QUADRANT_OF = [
  (e: string) => `Split the map into four quadrants (NE / NW / SE / SW) at the midpoint of its bounds. Which quadrant is ${e} in? Fill \`quadrant\`.`,
  (e: string) => `Relative to the map's center, which quadrant (NE/NW/SE/SW) contains ${e}? Fill \`quadrant\`.`,
  (e: string) => `Place ${e} in a quadrant of the map (split at the bounds midpoint): NE, NW, SE or SW? Fill \`quadrant\`.`,
  (e: string) => `In which quarter of the map (NE/NW/SE/SW, split at the center) does ${e} sit? Fill \`quadrant\`.`,
  (e: string) => `Report ${e}'s quadrant (map split into NE/NW/SE/SW at its midpoint) in \`quadrant\`.`,
  (e: string) => `Which map quadrant holds ${e} — NE, NW, SE or SW (center split)? Fill \`quadrant\`.`,
  (e: string) => `Fill \`quadrant\` with ${e}'s quadrant when the map is quartered at its bounds midpoint.`,
  (e: string) => `Locate ${e}: north or south half, east or west half — i.e. which quadrant (NE/NW/SE/SW)? Fill \`quadrant\`.`,
  (e: string) => `Quarter the map at its center; which cell (NE/NW/SE/SW) contains ${e}? Fill \`quadrant\`.`,
  (e: string) => `State the quadrant (NE/NW/SE/SW, split at the map midpoint) of ${e} in \`quadrant\`.`,
];

const T_EQUIP_IN_QUAD = [
  (q: string) => `Split the map into four quadrants (NE/NW/SE/SW) at the midpoint of its bounds. List every equipment item in the ${q} quadrant. Fill \`equipmentIds\` (empty array if none).`,
  (q: string) => `Which equipment sits in the ${q} quadrant (map split at the bounds midpoint)? Fill \`equipmentIds\` (empty if none).`,
  (q: string) => `List in \`equipmentIds\` the equipment located in the ${q} quarter of the map (center split; empty if none).`,
  (q: string) => `Quarter the map at its center; report the equipment ids inside the ${q} cell in \`equipmentIds\` (empty if none).`,
  (q: string) => `Which equipment items fall in the map's ${q} quadrant? Fill \`equipmentIds\` (empty array if none).`,
  (q: string) => `Report all equipment in quadrant ${q} (NE/NW/SE/SW split at the midpoint) in \`equipmentIds\` (empty if none).`,
  (q: string) => `Fill \`equipmentIds\` with every equipment id in the ${q} quadrant of the map (empty if none).`,
  (q: string) => `Scanning the ${q} quarter of the map (split at the center): which equipment is there? Fill \`equipmentIds\` (empty if none).`,
  (q: string) => `Enumerate equipment in the ${q} quadrant (bounds-midpoint split). Fill \`equipmentIds\` (empty array if none).`,
  (q: string) => `Give the ids of equipment positioned in the ${q} quadrant in \`equipmentIds\` (empty if none).`,
];

const T_UNSERVED = [
  () => "Which buildings appear in NO closure's serves list (unserved)? Fill `buildingIds` (empty array if none).",
  () => "List every building that no closure serves in `buildingIds` (empty if none).",
  () => "Report unserved buildings — absent from every serves list. Fill `buildingIds` (empty array if none).",
  () => "Are any buildings without a serving closure (not in any serves list)? Fill `buildingIds` (empty if none).",
  () => "Find buildings lacking an assigned closure (no serves entry). Fill `buildingIds` (empty array if none).",
  () => "Which building ids are missing from all closures' serves lists? Fill `buildingIds` (empty if none).",
  () => "Audit service assignment: list buildings served by nothing in `buildingIds` (empty array if none).",
  () => "Fill `buildingIds` with every building that has no serving closure (empty if none).",
  () => "Identify service orphans — buildings in no serves list. Fill `buildingIds` (empty array if none).",
  () => "Check each building against all serves lists; report the unmatched ones in `buildingIds` (empty if none).",
];

const T_BEARING8 = [
  (a: string, b: string) => `What is the compass direction from ${a} to ${b} — one of N, NE, E, SE, S, SW, W, NW? Fill \`direction\`.`,
  (a: string, b: string) => `Heading from ${a} toward ${b}: which of the 8 compass directions (N/NE/E/SE/S/SW/W/NW)? Fill \`direction\`.`,
  (a: string, b: string) => `In which compass direction (8-point: N, NE, E, SE, S, SW, W, NW) does ${b} lie from ${a}? Fill \`direction\`.`,
  (a: string, b: string) => `Report the 8-point bearing from ${a} to ${b} (N/NE/E/SE/S/SW/W/NW) in \`direction\`.`,
  (a: string, b: string) => `From ${a}'s position, which way is ${b} (choose from N, NE, E, SE, S, SW, W, NW)? Fill \`direction\`.`,
  (a: string, b: string) => `Give the compass octant of ${b} relative to ${a} in \`direction\` (N/NE/E/SE/S/SW/W/NW).`,
  (a: string, b: string) => `Fill \`direction\` with the 8-way compass direction from ${a} to ${b}.`,
  (a: string, b: string) => `Traveling straight from ${a} to ${b}, what compass direction are you heading (8-point)? Fill \`direction\`.`,
  (a: string, b: string) => `Which octant (N, NE, E, SE, S, SW, W or NW) describes ${b}'s position relative to ${a}? Fill \`direction\`.`,
  (a: string, b: string) => `State the direction from ${a} to ${b} using the 8-point compass in \`direction\`.`,
];

// ---------------------------------------------------------------------------
// NEW COMPUTE FAMILIES
// ---------------------------------------------------------------------------

const T_DIST_PAIR = [
  (a: string, b: string) => `What is the straight-line distance in meters between ${a} and ${b}? Fill \`meters\` with the number.`,
  (a: string, b: string) => `Measure the distance from ${a} to ${b} in meters. Fill \`meters\`.`,
  (a: string, b: string) => `How far apart are ${a} and ${b} (straight line, meters)? Fill \`meters\`.`,
  (a: string, b: string) => `Report the ${a}–${b} separation in meters in \`meters\`.`,
  (a: string, b: string) => `Compute the direct distance between ${a} and ${b} (meters). Fill \`meters\`.`,
  (a: string, b: string) => `Give the straight-line meters from ${a} to ${b} in \`meters\`.`,
  (a: string, b: string) => `Fill \`meters\` with the distance (in meters) separating ${a} and ${b}.`,
  (a: string, b: string) => `What distance in meters lies between ${a} and ${b}? Fill \`meters\`.`,
  (a: string, b: string) => `Determine how many meters separate ${a} from ${b}. Fill \`meters\`.`,
  (a: string, b: string) => `State the ${a}-to-${b} straight-line distance in meters in \`meters\`.`,
];

const T_RANK_K = [
  (b: string) => `List the ids of the 3 closures nearest to building ${b}, ordered nearest first. Fill \`equipmentIds\` with exactly 3 ids in order.`,
  (b: string) => `Rank the closures by distance from ${b} and report the top 3 (nearest first) in \`equipmentIds\`.`,
  (b: string) => `Which 3 closures are closest to ${b}? Fill \`equipmentIds\` with their ids, nearest first.`,
  (b: string) => `Give the 3 nearest closures to building ${b}, in increasing distance order, in \`equipmentIds\`.`,
  (b: string) => `Order closures by proximity to ${b}; fill \`equipmentIds\` with the nearest 3 in order.`,
  (b: string) => `Find the three closures with the smallest distance to ${b} (nearest first). Fill \`equipmentIds\`.`,
  (b: string) => `Fill \`equipmentIds\` with the 3 closures nearest ${b}, sorted nearest-first.`,
  (b: string) => `From ${b}, which are the top-3 closest closures, in order? Fill \`equipmentIds\`.`,
  (b: string) => `Report the 3 minimum-distance closures from building ${b} (ascending) in \`equipmentIds\`.`,
  (b: string) => `Select and order the 3 closures closest to ${b} (nearest first) in \`equipmentIds\`.`,
];

const T_WITHIN_R = [
  (e: string, r: string) => `How many buildings have their centroid within ${r}m of ${e}? Fill \`count\`.`,
  (e: string, r: string) => `Count the buildings whose centroid lies inside a ${r}m radius around ${e}. Fill \`count\`.`,
  (e: string, r: string) => `Within ${r} meters of ${e}, how many building centroids are there? Fill \`count\`.`,
  (e: string, r: string) => `Report in \`count\` the number of buildings within ${r}m (centroid distance) of ${e}.`,
  (e: string, r: string) => `How many buildings fall inside ${e}'s ${r}m circle (by centroid)? Fill \`count\`.`,
  (e: string, r: string) => `Tally buildings with centroid distance ≤ ${r}m from ${e}. Fill \`count\`.`,
  (e: string, r: string) => `Fill \`count\` with the number of building centroids within ${r}m of ${e}.`,
  (e: string, r: string) => `Give the count of buildings no farther than ${r}m (centroid) from ${e} in \`count\`.`,
  (e: string, r: string) => `Inside a ${r}m radius centered on ${e}: how many building centroids? Fill \`count\`.`,
  (e: string, r: string) => `State how many buildings are within ${r} meters of ${e} (centroid distance) in \`count\`.`,
];

const T_NEAREST_B = [
  (c: string) => `Which building's centroid is nearest to ${c}? Fill \`buildingIds\` with exactly that one id.`,
  (c: string) => `Find the building closest to ${c} (by centroid) and fill \`buildingIds\` with its single id.`,
  (c: string) => `Report the nearest building to ${c} in \`buildingIds\` (exactly one id).`,
  (c: string) => `Of all buildings, which centroid is at minimum distance from ${c}? Fill \`buildingIds\` with that one id.`,
  (c: string) => `Identify ${c}'s closest building. Fill \`buildingIds\` with exactly one id.`,
  (c: string) => `Which building would ${c} reach first (smallest centroid distance)? Fill \`buildingIds\` (one id).`,
  (c: string) => `Fill \`buildingIds\` with the single id of the building nearest ${c}.`,
  (c: string) => `Determine the minimum-distance building from ${c} and report it alone in \`buildingIds\`.`,
  (c: string) => `Give the one building whose centroid lies closest to ${c} in \`buildingIds\`.`,
  (c: string) => `Select the building nearest to ${c} (centroid distance). Fill \`buildingIds\` with exactly that id.`,
];

const T_OFFSTREET_VARIANT = [
  (b: string) => `Consider only the closures that are OFF-street — farther than 8m from every street centerline. Which of those is nearest to building ${b}? Fill \`closureId\` ('none' if every closure is on-street).`,
  (b: string) => `Among closures more than 8m from any street centerline (off-street), which is closest to ${b}? Fill \`closureId\` or 'none'.`,
  (b: string) => `Exclude on-street closures (within 8m of a centerline); of the rest, which is nearest ${b}? Fill \`closureId\` ('none' if none remain).`,
  (b: string) => `Which off-street closure (centerline distance > 8m) lies nearest to building ${b}? Fill \`closureId\` ('none' if all are on-street).`,
  (b: string) => `Filter to closures with street distance greater than 8m; report the one nearest ${b} in \`closureId\` ('none' if empty).`,
  (b: string) => `Find ${b}'s nearest closure among those NOT on a street (over 8m from every centerline). Fill \`closureId\` or 'none'.`,
  (b: string) => `Of the closures placed off-street (>8m from centerlines), which has the smallest distance to ${b}? Fill \`closureId\` ('none' if there are none).`,
  (b: string) => `Drop every closure within 8m of a street centerline; which remaining closure is closest to ${b}? Fill \`closureId\` ('none' if none).`,
  (b: string) => `Nearest off-street closure to ${b} (street distance must exceed 8m)? Fill \`closureId\` ('none' if all on-street).`,
  (b: string) => `Among strictly off-street closures (centerline distance > 8m), pick the nearest to ${b}. Fill \`closureId\` ('none' if empty).`,
];

const T_CROSSING_BOOL = [
  () => "Does ANY cable pass through a building footprint it does not terminate at? Fill `crosses` (true/false).",
  () => "Is there at least one cable crossing a foreign building (not its own endpoints)? Fill `crosses` (true/false).",
  () => "Check all cables: does any cross a building it neither starts nor ends at? Fill `crosses`.",
  () => "Report in `crosses` whether any cable intersects a non-terminal building footprint (true/false).",
  () => "Do any cable paths conflict with third-party buildings? Fill `crosses` (true/false).",
  () => "Is the cable plant clean of foreign-building crossings? Fill `crosses` with true if ANY crossing exists, false if none.",
  () => "Fill `crosses` (true/false): does at least one cable cut through a building it does not terminate at?",
  () => "After testing every cable against every non-terminal building: any crossings at all? Fill `crosses`.",
  () => "Answer true/false in `crosses`: some cable passes through a building other than its endpoints.",
  () => "Determine whether the scene contains any foreign-building cable crossing. Fill `crosses` (true/false).",
];

// ---------------------------------------------------------------------------
// Family builders
// ---------------------------------------------------------------------------

const quadrantOfPoint = (s: Scene, pos: [number, number], marginM: number): string | null => {
  const cx = (s.bounds.minLng + s.bounds.maxLng) / 2;
  const cy = (s.bounds.minLat + s.bounds.maxLat) / 2;
  const dxm = haversineMeters([cx, pos[1]], [pos[0], pos[1]]) * (pos[0] >= cx ? 1 : -1);
  const dym = haversineMeters([pos[0], cy], [pos[0], pos[1]]) * (pos[1] >= cy ? 1 : -1);
  if (Math.abs(dxm) < marginM || Math.abs(dym) < marginM) return null;
  return `${dym > 0 ? "N" : "S"}${dxm > 0 ? "E" : "W"}`;
};

/** 8-point compass from a to b with a sector margin (degrees); null if ambiguous. */
const bearing8 = (s: Scene, a: [number, number], b: [number, number], marginDeg: number): string | null => {
  const dx = xM(s, b) - xM(s, a);
  const dy = yM(s, b) - yM(s, a);
  if (Math.hypot(dx, dy) < 20) return null;
  const ang = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360; // 0=N, 90=E
  const sector = Math.round(ang / 45) % 8;
  const center = sector * 45;
  let diff = Math.abs(ang - center);
  if (diff > 180) diff = 360 - diff;
  if (diff > 22.5 - marginDeg) return null;
  return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][sector];
};

/** The single batch-crossing call for the whole cable plant (mirrors the
 *  runtime TOOL_CROSSING_HINT marshal: every cable, every ring, exclusions =
 *  each cable's terminal building). */
const crossingCall = (s: Scene): { call: string; extraction: string } => {
  const segments: Record<string, { a: [number, number]; b: [number, number]; exclude: string[] }> = {};
  const lines: string[] = [];
  const buildingIds = new Set(s.buildings.map((b) => b.id));
  for (const c of s.cables) {
    const a = ptM(s, c.path[0]);
    const b = ptM(s, c.path[c.path.length - 1]);
    const exclude = [c.sourceId, c.targetId].filter((id) => buildingIds.has(id));
    segments[c.id] = { a, b, exclude };
    lines.push(
      `${c.id}: ${c.sourceId} -> ${c.targetId}, m[${a[0]},${a[1]}] -> m[${b[0]},${b[1]}], exclude ${exclude.length ? exclude.join(",") : "(none)"}`,
    );
  }
  const rings: Record<string, [number, number][]> = {};
  for (const b of s.buildings) rings[b.id] = ringM(s, b);
  const call = JSON.stringify({ op: "segments_cross_polygons", units: "m", segments, rings });
  return { call, extraction: lines.join("\n") };
};

export const FAMILIES: TaskFamily[] = [
  // ------------------------------ CORE READ ------------------------------
  {
    id: "containment",
    kind: "read",
    templateCount: T_CONTAINMENT.length,
    build: (s, rand) => {
      const truth = closuresInsideBuildings(s);
      const lines = s.equipment.map((e) => {
        const inB = s.buildings.find((b) => pointInPolygon(e.position, b.footprint));
        return `${e.id}: ${inB ? `inside ${inB.id}` : "outside every footprint"}`;
      });
      return {
        prompt: tpl(T_CONTAINMENT, rand)(),
        extraction: lines.join("\n"),
        answer: { equipmentIds: truth },
      };
    },
  },
  {
    id: "onstreet",
    kind: "read",
    templateCount: T_ONSTREET.length,
    build: (s, rand) => {
      const id = firstClosureId(s);
      const e = s.equipment.find((x) => x.id === id);
      if (!e) return null;
      const d = distanceToNearestStreet(s, id);
      return {
        prompt: tpl(T_ONSTREET, rand)(id),
        extraction: `${id}: distance to nearest street centerline = ${fmt(d)}m (threshold ~8m)`,
        answer: { onStreet: isOnStreet(s, id) },
      };
    },
  },
  {
    id: "nearest",
    kind: "read",
    templateCount: T_NEAREST.length,
    build: (s, rand) => {
      const b = s.buildings[0];
      const truth = nearestClosureToBuilding(s, b.id) ?? "none";
      const ds = closuresOf(s)
        .map((c) => ({ id: c.id, d: haversineMeters(b.centroid, c.position) }))
        .sort((x, y) => x.d - y.d)
        .slice(0, 3);
      return {
        prompt: tpl(T_NEAREST, rand)(b.id),
        extraction: ds.map(({ id, d }) => `${id}: ${fmt(d)}m from ${b.id}`).join("\n"),
        answer: { closureId: truth },
      };
    },
  },
  {
    id: "coverage_gap",
    kind: "read",
    templateCount: T_COVERAGE.length,
    build: (s, rand) => {
      const truth = coverageGapBuildings(s);
      const cls = closuresOf(s);
      if (cls.length === 0) return null;
      const lines = s.buildings.map((b) => {
        const d = Math.min(...cls.map((c) => haversineMeters(b.centroid, c.position)));
        return `${b.id}: nearest closure ${fmt(d)}m${d > 35 ? "  -> GAP (>35m)" : ""}`;
      });
      return {
        prompt: tpl(T_COVERAGE, rand)(),
        extraction: lines.join("\n"),
        answer: { buildingIds: truth },
      };
    },
  },
  {
    id: "topology",
    kind: "read",
    templateCount: T_TOPOLOGY.length,
    build: (s, rand) => {
      const bid = topologyBuilding(s);
      const truth = pathToSource(s, bid);
      const serving = s.equipment.find((e) => e.kind === "closure" && e.serves.includes(bid));
      const co = coEquip(s);
      const L = [`${bid} is served by ${serving?.id ?? "?"} (its serves list contains ${bid}).`];
      if (co) L.push(`The network source is ${co.id}. Path nearest-first: serving closure, then source.`);
      return {
        prompt: tpl(T_TOPOLOGY, rand)(bid),
        extraction: L.join("\n"),
        answer: { equipmentPath: truth },
      };
    },
  },
  // ----------------------------- CORE COMPUTE -----------------------------
  {
    id: "crossing",
    kind: "compute",
    templateCount: T_CROSSING.length,
    build: (s, rand) => {
      if (s.cables.length === 0) return null;
      const truth = cablesCrossingForeignBuildings(s);
      const { call, extraction } = crossingCall(s);
      return {
        prompt: tpl(T_CROSSING, rand)(),
        extraction: `Cables (endpoints in meters, exclusion = terminal building):\n${extraction}\nRings: every building footprint from FOOTPRINTS.`,
        answer: { cableIds: truth },
        toolCalls: [call],
        conclude: (results) => {
          const m = parseCrossings(results);
          const hit = s.cables.map((c) => c.id).filter((id) => (m.get(id) ?? []).length > 0);
          if (!setEqual(hit, truth)) return null;
          return `From TOOL_RESULTS, cables crossing a non-excluded building: ${hit.length ? hit.join(", ") : "(none)"}.`;
        },
      };
    },
  },
  {
    id: "blockage",
    kind: "compute",
    templateCount: T_BLOCKAGE.length,
    build: (s, rand) => {
      const co = coEquip(s);
      if (!co) return null;
      const t = blockageTarget(s);
      const a = ptM(s, co.position);
      const b = ptM(s, t.centroid);
      const rings: Record<string, [number, number][]> = {};
      for (const bl of s.buildings) rings[bl.id] = ringM(s, bl);
      const call = JSON.stringify({
        op: "segments_cross_polygons",
        units: "m",
        segments: { [`${co.id}_to_${t.id}`]: { a, b, exclude: [t.id] } },
        rings,
      });
      const truth = lineCrossesBuildings(s, co.position, t.centroid, t.id);
      return {
        prompt: tpl(T_BLOCKAGE, rand)(co.id, t.id),
        extraction: `Segment ${co.id} m[${a[0]},${a[1]}] -> ${t.id} m[${b[0]},${b[1]}]; exclude ${t.id}. Rings: every building footprint.`,
        answer: { buildingIds: truth },
        toolCalls: [call],
        conclude: (results) => {
          const m = parseCrossings(results);
          const hits = m.get(`${co.id}_to_${t.id}`) ?? [];
          if (!setEqual(hits, truth)) return null;
          return `From TOOL_RESULTS, the segment crosses: ${hits.length ? hits.join(", ") : "(none)"}.`;
        },
      };
    },
  },
  {
    id: "enclosure",
    kind: "compute",
    templateCount: T_ENCLOSURE.length,
    build: (s, rand) => {
      if (s.buildings.length < 4) return null;
      const truth = interiorBuildings(s);
      const points: Record<string, [number, number]> = {};
      for (const b of s.buildings) points[b.id] = ptM(s, b.centroid);
      const call = JSON.stringify({ op: "convex_hull", units: "m", points });
      return {
        prompt: tpl(T_ENCLOSURE, rand)(),
        extraction: `Building centroids (meters): ${Object.entries(points)
          .map(([id, p]) => `${id}[${p[0]},${p[1]}]`)
          .join(" ")}`,
        answer: { buildingIds: truth },
        toolCalls: [call],
        conclude: (results) => {
          const interior = parseInterior(results);
          if (!interior || !setEqual(interior, truth)) return null;
          return `From TOOL_RESULTS, interior (non-hull) buildings: ${interior.length ? interior.join(", ") : "(none)"}.`;
        },
      };
    },
  },
  {
    id: "road_misplacement",
    kind: "compute",
    templateCount: T_ROAD.length,
    build: (s, rand) => {
      const truth = equipmentInRoad(s);
      const cand = s.equipment.filter((e) => e.kind !== "co");
      if (cand.length === 0) return null;
      const values: Record<string, number> = {};
      for (const e of cand) values[e.id] = Number(fmt(distanceToNearestStreet(s, e.id)));
      const call = JSON.stringify({
        op: "filter_threshold",
        cmp: "le",
        threshold: ORACLE_CONSTANTS.IN_ROAD_M,
        values,
      });
      return {
        prompt: tpl(T_ROAD, rand)(),
        extraction: cand.map((e) => `${e.id}: d_street=${fmt(values[e.id])}m`).join("\n"),
        answer: { equipmentIds: truth },
        toolCalls: [call],
        conclude: (results) => {
          const f = parseFilter(results);
          if (!f || !setEqual(f.pass, truth)) return null;
          return `From TOOL_RESULTS, items at ≤${ORACLE_CONSTANTS.IN_ROAD_M}m: ${f.pass.length ? f.pass.join(", ") : "(none)"}.`;
        },
      };
    },
  },
  {
    id: "nearest_offstreet",
    kind: "compute",
    templateCount: T_OFFSTREET.length,
    build: (s, rand) => {
      const bid = offstreetTargetBuilding(s);
      const b = s.buildings.find((x) => x.id === bid);
      if (!b) return null;
      const home = streetOf(s, b.centroid);
      if (!home) return null;
      const truth = nearestClosureOffStreet(s, bid) ?? "none";
      const candidates: Record<string, { xy: [number, number]; street: string }> = {};
      const lines: string[] = [`${bid} home street: ${home}; ${bid} at m[${ptM(s, b.centroid).join(",")}]`];
      for (const c of closuresOf(s)) {
        const st = streetOf(s, c.position) ?? "none";
        candidates[c.id] = { xy: ptM(s, c.position), street: st };
        lines.push(`${c.id}: street=${st}, m[${candidates[c.id].xy.join(",")}]`);
      }
      const call = JSON.stringify({
        op: "nearest_where",
        units: "m",
        target: ptM(s, b.centroid),
        exclude_field: "street",
        exclude_value: home,
        candidates,
      });
      return {
        prompt: tpl(T_OFFSTREET, rand)(bid),
        extraction: lines.join("\n"),
        answer: { closureId: truth },
        toolCalls: [call],
        conclude: (results) => {
          const nearest = parseNearest(results);
          if (nearest === null || nearest !== truth) return null;
          return `From TOOL_RESULTS, nearest closure off ${home}: ${nearest}.`;
        },
      };
    },
  },
  // ------------------------------ NEW READ ------------------------------
  {
    id: "count_kind",
    kind: "read",
    templateCount: T_COUNT_KIND.length,
    build: (s, rand) => {
      const kinds: ["closures", "cables", "buildings"] = ["closures", "cables", "buildings"];
      const k = pick(kinds as unknown as string[], rand);
      const n =
        k === "closures" ? closuresOf(s).length : k === "cables" ? s.cables.length : s.buildings.length;
      const ids =
        k === "closures"
          ? closuresOf(s).map((e) => e.id)
          : k === "cables"
            ? s.cables.map((c) => c.id)
            : s.buildings.map((b) => b.id);
      return {
        prompt: tpl(T_COUNT_KIND, rand)(k),
        extraction: `${k}: ${ids.join(", ")} — total ${n}`,
        answer: { count: n },
      };
    },
  },
  {
    id: "count_on_street",
    kind: "read",
    templateCount: T_COUNT_ON_STREET.length,
    build: (s, rand) => {
      const byStreet = new Map<string, string[]>();
      for (const c of closuresOf(s)) {
        const st = streetOf(s, c.position);
        if (!st) continue;
        byStreet.set(st, [...(byStreet.get(st) ?? []), c.id]);
      }
      const entries = [...byStreet.entries()].sort((a, b) => b[1].length - a[1].length);
      if (entries.length === 0) return null;
      const [st, ids] = pick(entries, rand);
      const lines = closuresOf(s).map((c) => `${c.id}: nearest street ${streetOf(s, c.position) ?? "(unnamed)"}`);
      return {
        prompt: tpl(T_COUNT_ON_STREET, rand)(st),
        extraction: `${lines.join("\n")}\nMatching "${st}": ${ids.join(", ")}`,
        answer: { count: ids.length },
      };
    },
  },
  {
    id: "street_of",
    kind: "read",
    templateCount: T_STREET_OF.length,
    build: (s, rand) => {
      const named = s.buildings.filter((b) => streetOf(s, b.centroid));
      if (named.length === 0) return null;
      const b = pick(named, rand);
      const st = streetOf(s, b.centroid);
      if (!st) return null;
      return {
        prompt: tpl(T_STREET_OF, rand)(b.id),
        extraction: `${b.id}: nearest street = ${st}`,
        answer: { street: st },
      };
    },
  },
  {
    id: "same_street_pair",
    kind: "read",
    templateCount: T_SAME_STREET.length,
    build: (s, rand) => {
      const named = s.buildings
        .map((b) => ({ b, st: streetOf(s, b.centroid) }))
        .filter((x): x is { b: SceneBuilding; st: string } => x.st !== null);
      if (named.length < 2) return null;
      // Balance true/false: try to honor the coin when the scene allows it.
      const wantSame = rand() < 0.5;
      let pair: [{ b: SceneBuilding; st: string }, { b: SceneBuilding; st: string }] | null = null;
      outer: for (let i = 0; i < named.length; i++) {
        for (let j = i + 1; j < named.length; j++) {
          if ((named[i].st === named[j].st) === wantSame) {
            pair = [named[i], named[j]];
            break outer;
          }
        }
      }
      if (!pair) pair = [named[0], named[1]];
      const [A, B] = pair;
      return {
        prompt: tpl(T_SAME_STREET, rand)(A.b.id, B.b.id),
        extraction: `${A.b.id}: nearest street = ${A.st}\n${B.b.id}: nearest street = ${B.st}`,
        answer: { sameStreet: A.st === B.st },
      };
    },
  },
  {
    id: "serves_lookup",
    kind: "read",
    templateCount: T_SERVES.length,
    build: (s, rand) => {
      const withServes = closuresOf(s).filter((c) => c.serves.length > 0);
      if (withServes.length === 0) return null;
      const c = pick(withServes, rand);
      return {
        prompt: tpl(T_SERVES, rand)(c.id),
        extraction: `${c.id}: serves=${c.serves.join(",")}`,
        answer: { buildingIds: [...c.serves] },
      };
    },
  },
  {
    id: "served_by_lookup",
    kind: "read",
    templateCount: T_SERVED_BY.length,
    build: (s, rand) => {
      const served = s.buildings.filter((b) =>
        s.equipment.some((e) => e.kind === "closure" && e.serves.includes(b.id)),
      );
      if (served.length === 0) return null;
      const b = pick(served, rand);
      const c = s.equipment.find((e) => e.kind === "closure" && e.serves.includes(b.id));
      if (!c) return null;
      return {
        prompt: tpl(T_SERVED_BY, rand)(b.id),
        extraction: `${c.id}: serves list contains ${b.id}`,
        answer: { closureId: c.id },
      };
    },
  },
  {
    id: "cable_endpoints",
    kind: "read",
    templateCount: T_ENDPOINTS.length,
    build: (s, rand) => {
      if (s.cables.length === 0) return null;
      const c = pick(s.cables, rand);
      return {
        prompt: tpl(T_ENDPOINTS, rand)(c.id),
        extraction: `${c.id}: source=${c.sourceId} target=${c.targetId}`,
        answer: { endpoints: [c.sourceId, c.targetId] },
      };
    },
  },
  {
    id: "degree",
    kind: "read",
    templateCount: T_DEGREE.length,
    build: (s, rand) => {
      const cls = closuresOf(s);
      if (cls.length === 0 || s.cables.length === 0) return null;
      const e = pick(cls, rand);
      const incident = s.cables.filter((c) => c.sourceId === e.id || c.targetId === e.id);
      return {
        prompt: tpl(T_DEGREE, rand)(e.id),
        extraction: incident.length
          ? incident.map((c) => `${c.id}: ${c.sourceId} -> ${c.targetId}`).join("\n")
          : `No cable lists ${e.id} as source or target.`,
        answer: { count: incident.length },
      };
    },
  },
  {
    id: "path_hops",
    kind: "read",
    templateCount: T_HOPS.length,
    build: (s, rand) => {
      const bid = topologyBuilding(s);
      const path = pathToSource(s, bid);
      if (path.length === 0) return null;
      return {
        prompt: tpl(T_HOPS, rand)(bid),
        extraction: `Path from ${bid}: ${path.join(" -> ")} (${path.length} equipment items)`,
        answer: { count: path.length },
      };
    },
  },
  {
    // COMPUTE post-audit: hull= no longer exists in the legend, so hull
    // membership must be computed, not read — same convex_hull op as enclosure.
    id: "hull_membership",
    kind: "compute",
    templateCount: T_HULL_MEMBER.length,
    build: (s, rand) => {
      if (s.buildings.length < 4) return null;
      const interior = new Set(interiorBuildings(s));
      // Alternate perimeter/interior picks for label balance when possible.
      const wantInterior = rand() < 0.5 && interior.size > 0;
      const cands = s.buildings.filter((b) => interior.has(b.id) === wantInterior);
      const b = pick(cands.length ? cands : s.buildings, rand);
      const isInterior = interior.has(b.id);
      const points: Record<string, [number, number]> = {};
      for (const bl of s.buildings) points[bl.id] = ptM(s, bl.centroid);
      const call = JSON.stringify({ op: "convex_hull", units: "m", points });
      return {
        prompt: tpl(T_HULL_MEMBER, rand)(b.id),
        extraction: `Building centroids (meters): ${Object.entries(points)
          .map(([id, p]) => `${id}[${p[0]},${p[1]}]`)
          .join(" ")}`,
        answer: { onHull: !isInterior },
        toolCalls: [call],
        conclude: (results) => {
          const interior2 = parseInterior(results);
          if (!interior2) return null;
          const computedInterior = interior2.includes(b.id);
          if (computedInterior !== isInterior) return null;
          return `From TOOL_RESULTS, ${b.id} is ${computedInterior ? "interior (not on the hull)" : "a hull vertex"}.`;
        },
      };
    },
  },
  {
    id: "quadrant_of",
    kind: "read",
    templateCount: T_QUADRANT_OF.length,
    build: (s, rand) => {
      const cands = s.equipment
        .map((e) => ({ e, q: quadrantOfPoint(s, e.position, 15) }))
        .filter((x): x is { e: SceneEquipment; q: string } => x.q !== null);
      if (cands.length === 0) return null;
      const { e, q } = pick(cands, rand);
      const p = ptM(s, e.position);
      const cx = Math.round(xM(s, [s.bounds.maxLng, s.bounds.minLat]) / 2);
      const cy = Math.round(yM(s, [s.bounds.minLng, s.bounds.maxLat]) / 2);
      return {
        prompt: tpl(T_QUADRANT_OF, rand)(e.id),
        extraction: `Map center ≈ m[${cx},${cy}]; ${e.id} at m[${p[0]},${p[1]}] → ${p[1] > cy ? "north" : "south"} half, ${p[0] > cx ? "east" : "west"} half.`,
        answer: { quadrant: q },
      };
    },
  },
  {
    id: "equipment_in_quadrant",
    kind: "read",
    templateCount: T_EQUIP_IN_QUAD.length,
    build: (s, rand) => {
      // Every equipment must clear the margin or the family is skipped —
      // excluding a borderline item would silently change the truth.
      const qs = s.equipment.map((e) => ({ e, q: quadrantOfPoint(s, e.position, 12) }));
      if (qs.some((x) => x.q === null)) return null;
      const byQ = new Map<string, string[]>();
      for (const { e, q } of qs) byQ.set(q as string, [...(byQ.get(q as string) ?? []), e.id]);
      const quads = ["NE", "NW", "SE", "SW"];
      const q = pick(quads, rand);
      const ids = byQ.get(q) ?? [];
      return {
        prompt: tpl(T_EQUIP_IN_QUAD, rand)(q),
        extraction: qs.map(({ e, q: eq }) => `${e.id}: ${eq}`).join("\n"),
        answer: { equipmentIds: ids },
      };
    },
  },
  {
    id: "unserved",
    kind: "read",
    templateCount: T_UNSERVED.length,
    build: (s, rand) => {
      const served = new Set(s.equipment.flatMap((e) => e.serves));
      const orphans = s.buildings.filter((b) => !served.has(b.id)).map((b) => b.id);
      return {
        prompt: tpl(T_UNSERVED, rand)(),
        extraction: `Buildings in some serves list: ${[...served].join(", ") || "(none)"}\nNot in any: ${orphans.join(", ") || "(none)"}`,
        answer: { buildingIds: orphans },
      };
    },
  },
  {
    id: "bearing8",
    kind: "read",
    templateCount: T_BEARING8.length,
    build: (s, rand) => {
      const co = coEquip(s);
      if (!co) return null;
      const cands = s.equipment
        .filter((e) => e.id !== co.id)
        .map((e) => ({ e, dir: bearing8(s, co.position, e.position, 6) }))
        .filter((x): x is { e: SceneEquipment; dir: string } => x.dir !== null);
      if (cands.length === 0) return null;
      const { e, dir } = pick(cands, rand);
      const a = ptM(s, co.position);
      const b = ptM(s, e.position);
      return {
        prompt: tpl(T_BEARING8, rand)(co.id, e.id),
        extraction: `${co.id} at m[${a[0]},${a[1]}]; ${e.id} at m[${b[0]},${b[1]}] → dx=${b[0] - a[0]} (east+), dy=${b[1] - a[1]} (north+).`,
        answer: { direction: dir },
      };
    },
  },
  // ----------------------------- NEW COMPUTE -----------------------------
  {
    id: "dist_pair",
    kind: "compute",
    templateCount: T_DIST_PAIR.length,
    build: (s, rand) => {
      if (s.equipment.length < 2) return null;
      const a = pick(s.equipment, rand);
      let b = pick(s.equipment, rand);
      if (b.id === a.id) b = s.equipment.find((x) => x.id !== a.id) ?? b;
      if (b.id === a.id) return null;
      const pa = ptM(s, a.position);
      const pb = ptM(s, b.position);
      // Same math as the executor's dist op on the same integer coords, so the
      // label provably equals what the tool returns.
      const expected = Number(Math.hypot(pa[0] - pb[0], pa[1] - pb[1]).toFixed(1));
      const call = JSON.stringify({ op: "dist", units: "m", a: pa, b: pb, note: `${a.id}-${b.id}` });
      return {
        prompt: tpl(T_DIST_PAIR, rand)(a.id, b.id),
        extraction: `${a.id} at m[${pa[0]},${pa[1]}]; ${b.id} at m[${pb[0]},${pb[1]}].`,
        answer: { meters: expected },
        toolCalls: [call],
        conclude: (results) => {
          const d = parseDist(results);
          if (d === null || d !== expected) return null;
          return `From TOOL_RESULTS: ${a.id} to ${b.id} = ${d}m.`;
        },
      };
    },
  },
  {
    id: "rank_k_closures",
    kind: "compute",
    templateCount: T_RANK_K.length,
    build: (s, rand) => {
      const cls = closuresOf(s);
      if (cls.length < 4) return null;
      const b = s.buildings[Math.floor(rand() * s.buildings.length) % s.buildings.length];
      const ranked = cls
        .map((c) => ({ id: c.id, d: haversineMeters(b.centroid, c.position) }))
        .sort((x, y) => x.d - y.d);
      if (ranked[3].d - ranked[2].d < 2 || ranked[2].d - ranked[1].d < 1 || ranked[1].d - ranked[0].d < 1)
        return null; // ambiguous ordering under rounding
      const truth = ranked.slice(0, 3).map((r) => r.id);
      const candidates: Record<string, { xy: [number, number]; street: string }> = {};
      for (const c of cls) candidates[c.id] = { xy: ptM(s, c.position), street: "-" };
      const call = JSON.stringify({
        op: "nearest_where",
        units: "m",
        target: ptM(s, b.centroid),
        exclude_field: "street",
        exclude_value: "(no such street)",
        candidates,
      });
      return {
        prompt: tpl(T_RANK_K, rand)(b.id),
        extraction: `${b.id} at m[${ptM(s, b.centroid).join(",")}]; candidates: ${cls.map((c) => `${c.id}[${ptM(s, c.position).join(",")}]`).join(" ")}`,
        answer: { equipmentIds: truth },
        toolCalls: [call],
        conclude: (results) => {
          const ranked2 = parseRanked(results).slice(0, 3).map((r) => r.id);
          if (!orderedEqual(ranked2, truth)) return null;
          return `From TOOL_RESULTS ranked list, nearest 3: ${ranked2.join(", ")}.`;
        },
      };
    },
  },
  {
    id: "within_radius_count",
    kind: "compute",
    templateCount: T_WITHIN_R.length,
    build: (s, rand) => {
      const co = coEquip(s);
      const eq = co ?? s.equipment[0];
      if (!eq) return null;
      const R = pick([40, 60, 80], rand);
      const ds = s.buildings.map((b) => haversineMeters(eq.position, b.centroid));
      if (ds.some((d) => Math.abs(d - R) < 3)) return null; // boundary ambiguity
      const truth = ds.filter((d) => d <= R).length;
      const candidates: Record<string, { xy: [number, number]; street: string }> = {};
      for (const b of s.buildings) candidates[b.id] = { xy: ptM(s, b.centroid), street: "-" };
      const call = JSON.stringify({
        op: "nearest_where",
        units: "m",
        target: ptM(s, eq.position),
        exclude_field: "street",
        exclude_value: "(no such street)",
        candidates,
      });
      return {
        prompt: tpl(T_WITHIN_R, rand)(eq.id, String(R)),
        extraction: `${eq.id} at m[${ptM(s, eq.position).join(",")}]; building centroids marshaled as candidates.`,
        answer: { count: truth },
        toolCalls: [call],
        conclude: (results) => {
          const n = parseRanked(results).filter((r) => r.d <= R).length;
          if (n !== truth) return null;
          return `From TOOL_RESULTS ranked distances, buildings at ≤${R}m: ${n}.`;
        },
      };
    },
  },
  {
    id: "nearest_building_to_closure",
    kind: "compute",
    templateCount: T_NEAREST_B.length,
    build: (s, rand) => {
      const cls = closuresOf(s);
      if (cls.length === 0 || s.buildings.length < 2) return null;
      const c = pick(cls, rand);
      const ranked = s.buildings
        .map((b) => ({ id: b.id, d: haversineMeters(c.position, b.centroid) }))
        .sort((x, y) => x.d - y.d);
      if (ranked[1].d - ranked[0].d < 2) return null;
      const truth = ranked[0].id;
      const candidates: Record<string, { xy: [number, number]; street: string }> = {};
      for (const b of s.buildings) candidates[b.id] = { xy: ptM(s, b.centroid), street: "-" };
      const call = JSON.stringify({
        op: "nearest_where",
        units: "m",
        target: ptM(s, c.position),
        exclude_field: "street",
        exclude_value: "(no such street)",
        candidates,
      });
      return {
        prompt: tpl(T_NEAREST_B, rand)(c.id),
        extraction: `${c.id} at m[${ptM(s, c.position).join(",")}]; building centroids marshaled as candidates.`,
        answer: { buildingIds: [truth] },
        toolCalls: [call],
        conclude: (results) => {
          const nearest = parseNearest(results);
          if (nearest !== truth) return null;
          return `From TOOL_RESULTS, nearest building: ${nearest}.`;
        },
      };
    },
  },
  {
    id: "offstreet_variant",
    kind: "compute",
    templateCount: T_OFFSTREET_VARIANT.length,
    build: (s, rand) => {
      const b = s.buildings[0];
      const cls = closuresOf(s);
      if (cls.length === 0) return null;
      const withD = cls.map((c) => ({ c, d: distanceToNearestStreet(s, c.id) }));
      if (withD.some((x) => Math.abs(x.d - 8) < 0.5)) return null; // threshold ambiguity
      const off = withD.filter((x) => x.d > 8);
      const truth = off.length
        ? off
            .map((x) => ({ id: x.c.id, d: haversineMeters(b.centroid, x.c.position) }))
            .sort((p, q) => p.d - q.d)[0].id
        : "none";
      if (off.length >= 2) {
        const ds = off
          .map((x) => haversineMeters(b.centroid, x.c.position))
          .sort((p, q) => p - q);
        if (ds[1] - ds[0] < 2) return null;
      }
      const lines = withD.map((x) => `${x.c.id}: d_street=${fmt(x.d)}m${x.d > 8 ? " (off-street)" : " (on-street, dropped)"}`);
      const example: BankExample = {
        prompt: tpl(T_OFFSTREET_VARIANT, rand)(b.id),
        extraction: `${lines.join("\n")}\n${b.id} at m[${ptM(s, b.centroid).join(",")}].`,
        answer: { closureId: truth },
      };
      if (off.length > 0) {
        const candidates: Record<string, { xy: [number, number]; street: string }> = {};
        for (const x of off) candidates[x.c.id] = { xy: ptM(s, x.c.position), street: "-" };
        example.toolCalls = [
          JSON.stringify({
            op: "nearest_where",
            units: "m",
            target: ptM(s, b.centroid),
            exclude_field: "street",
            exclude_value: "(no such street)",
            candidates,
          }),
        ];
        example.conclude = (results) => {
          const nearest = parseNearest(results);
          if (nearest !== truth) return null;
          return `From TOOL_RESULTS over the off-street candidates, nearest: ${nearest}.`;
        };
      }
      return example;
    },
  },
  {
    id: "crossing_boolean",
    kind: "compute",
    templateCount: T_CROSSING_BOOL.length,
    build: (s, rand) => {
      if (s.cables.length === 0) return null;
      const truth = cablesCrossingForeignBuildings(s).length > 0;
      const { call, extraction } = crossingCall(s);
      return {
        prompt: tpl(T_CROSSING_BOOL, rand)(),
        extraction: `Cables (endpoints in meters, exclusion = terminal building):\n${extraction}\nRings: every building footprint.`,
        answer: { crosses: truth },
        toolCalls: [call],
        conclude: (results) => {
          const m = parseCrossings(results);
          const any = [...m.values()].some((v) => v.length > 0);
          if (any !== truth) return null;
          return `From TOOL_RESULTS: ${any ? "at least one cable crosses a non-excluded building" : "no cable crosses any non-excluded building"}.`;
        },
      };
    },
  },
];

/** Families reserved for the generalization eval — NEVER generated above. */
export const HELDOUT_RESERVED: readonly string[] = [
  // Reserved family names (eval-side implementation, never trained):
  "farthest_closure",
  "count_crossing",
  "mid_between_closures",
  "same_side_street",
  // The frozen hold-out questions of questions.ts:
  "ho_count_inside",
  "ho_closer",
  "ho_bearing",
  "ho_midpoint",
  "ho_quadrant",
  "ho_rank3",
];

/** Total distinct templates across trained families (the >300 Only-IF bound). */
export const TEMPLATE_TOTAL: number = FAMILIES.reduce((n, f) => n + f.templateCount, 0);

/** Sanity: no trained family may collide with a held-out name. */
for (const f of FAMILIES) {
  if (HELDOUT_RESERVED.includes(f.id)) {
    throw new Error(`task-bank: trained family '${f.id}' collides with the held-out set`);
  }
}
