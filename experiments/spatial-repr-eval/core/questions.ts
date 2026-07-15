/**
 * Question bank. Each question binds a prompt to a deterministic grader that
 * compares the model's structured answer against the oracle's ground truth.
 *
 * Questions are bucketed into the protocol's eight categories (containment,
 * crossing, on-street, nearest, coverage, path, line-intersection, mixed) so the
 * report can test whether representation effects differ by task type.
 * The prompt is identical across all arms — only the representation prefix
 * (added by the engine) differs.
 */

import { haversineMeters } from "./geo";
import { orderedEqual, setEqual } from "./grade";
import {
  bearingNorthSouth,
  cablesCrossingForeignBuildings,
  closuresInsideBuildings,
  coverageGapBuildings,
  densestQuadrants,
  equipmentInRoad,
  interiorBuildings,
  isOnStreet,
  lineCrossesBuildings,
  midpointNearestBuilding,
  nearerBuildingOfPair,
  nearestClosureOffStreet,
  nearestClosureToBuilding,
  nearestKBuildings,
  nearestStreetIsNamed,
  ORACLE_CONSTANTS,
  pathToSource,
} from "./oracle";
import type { Scene, SceneBuilding, SceneEquipment } from "./scene";

/** The eight task categories of the experiment protocol. `mixed` combines two or
 *  more primitive relations in one question. */
export type Category =
  | "containment"
  | "crossing"
  | "on-street"
  | "nearest"
  | "coverage"
  | "path"
  | "line-intersection"
  | "mixed"
  /** Hold-out question types written AFTER the v2.5 freeze — never used during
   *  representation iteration. Run opt-in (questionIds: ho_*), reported separately. */
  | "holdout";

export interface Answer {
  equipmentIds?: string[];
  cableIds?: string[];
  buildingIds?: string[];
  closureId?: string;
  onStreet?: boolean;
  equipmentPath?: string[];
  /** Numeric answer (hold-out counting question). */
  count?: number;
  /** 'north' | 'south' (hold-out bearing question). */
  direction?: string;
  /** 'NE' | 'NW' | 'SE' | 'SW' (hold-out quadrant question). */
  quadrant?: string;
  /** The model's report that the representation lacks needed information. The
   *  forced tool call means it can't literally ask — this field records the ask. */
  missingInfo?: string;
}

/** JSON schema for the forced `submit_answer` tool. */
export const ANSWER_TOOL_SCHEMA = {
  type: "object",
  properties: {
    equipmentIds: { type: "array", items: { type: "string" } },
    cableIds: { type: "array", items: { type: "string" } },
    buildingIds: { type: "array", items: { type: "string" } },
    closureId: { type: "string", description: "an id, or 'none'" },
    onStreet: { type: "boolean" },
    equipmentPath: { type: "array", items: { type: "string" } },
    count: { type: "number", description: "numeric answer, when the question asks for a count" },
    direction: { type: "string", description: "'north' or 'south', when asked" },
    quadrant: { type: "string", description: "'NE', 'NW', 'SE' or 'SW', when asked" },
    missingInfo: {
      type: "string",
      description:
        "ONLY if the provided map representation truly lacks the information needed to answer, " +
        "briefly state what is missing. Otherwise omit this field.",
    },
  },
  additionalProperties: false,
} as const;

export interface Question {
  id: string;
  category: Category;
  prompt: (scene: Scene) => string;
  grade: (scene: Scene, a: Answer) => boolean;
}

function firstClosureId(scene: Scene): string {
  return scene.equipment.find((e) => e.kind === "closure")?.id ?? "CL-A";
}

function topologyBuilding(scene: Scene): string {
  // a building that has a serving closure (avoid the coverage-gap building)
  const served = scene.buildings.find((b) =>
    scene.equipment.some((e) => e.kind === "closure" && e.serves.includes(b.id)),
  );
  return served?.id ?? scene.buildings[0].id;
}

function coEquip(scene: Scene): SceneEquipment | undefined {
  return scene.equipment.find((e) => e.kind === "co");
}

/** Target for the nearest-offstreet question: a building whose nearest street has a
 *  REAL name. The textmap legend omits the "street N" placeholder for unnamed OSM
 *  ways, so an unnamed target would test legend coverage instead of reasoning. */
function offstreetTargetBuilding(scene: Scene): string {
  const named = scene.buildings.find((b) => nearestStreetIsNamed(scene, b.centroid));
  return (named ?? scene.buildings[0]).id;
}

/** Building farthest from the CO — gives a long line likely to cross the cluster. */
function blockageTarget(scene: Scene): SceneBuilding {
  const co = coEquip(scene);
  if (!co) return scene.buildings[scene.buildings.length - 1];
  let best = scene.buildings[0];
  let bd = -1;
  for (const b of scene.buildings) {
    const d = haversineMeters(co.position, b.centroid);
    if (d > bd) {
      bd = d;
      best = b;
    }
  }
  return best;
}

export const QUESTIONS: Question[] = [
  {
    id: "containment",
    category: "containment",
    prompt: () =>
      "List the ids of every equipment item whose point lies INSIDE a building footprint. " +
      "Fill `equipmentIds` (empty array if none).",
    grade: (scene, a) => setEqual(a.equipmentIds ?? [], closuresInsideBuildings(scene)),
  },
  {
    id: "crossing",
    category: "crossing",
    prompt: () =>
      "List the ids of every cable whose path passes THROUGH a building footprint it does not " +
      "terminate at. Fill `cableIds` (empty array if none).",
    grade: (scene, a) => setEqual(a.cableIds ?? [], cablesCrossingForeignBuildings(scene)),
  },
  {
    id: "onstreet",
    category: "on-street",
    prompt: (scene) =>
      `Is equipment ${firstClosureId(scene)} placed on a street (within ~8m of a street centerline), ` +
      "as opposed to off-street / inside a building? Fill `onStreet` (true/false).",
    grade: (scene, a) => (a.onStreet ?? null) === isOnStreet(scene, firstClosureId(scene)),
  },
  {
    id: "nearest",
    category: "nearest",
    prompt: (scene) =>
      `Which closure is geographically nearest to building ${scene.buildings[0].id}? ` +
      "Fill `closureId` with its id.",
    grade: (scene, a) =>
      (a.closureId ?? "none") ===
      (nearestClosureToBuilding(scene, scene.buildings[0].id) ?? "none"),
  },
  {
    id: "coverage_gap",
    category: "coverage",
    prompt: () =>
      "Is there any building with NO closure within 35m of it (a coverage gap)? " +
      "Fill `buildingIds` with every such building (empty array if none).",
    grade: (scene, a) => setEqual(a.buildingIds ?? [], coverageGapBuildings(scene)),
  },
  {
    id: "topology",
    category: "path",
    prompt: (scene) =>
      `List the equipment on the path from building ${topologyBuilding(scene)} to the source ` +
      "(the CO), nearest-first. Fill `equipmentPath` with the ordered ids.",
    grade: (scene, a) =>
      orderedEqual(a.equipmentPath ?? [], pathToSource(scene, topologyBuilding(scene))),
  },
  {
    id: "blockage",
    category: "line-intersection",
    prompt: (scene) => {
      const co = coEquip(scene);
      const t = blockageTarget(scene);
      return (
        `If a straight cable runs from ${co?.id ?? "CO-1"} to building ${t.id}, list the ids of ` +
        `every OTHER building whose footprint the straight line passes through (exclude ${t.id}). ` +
        "Fill `buildingIds` (empty array if none)."
      );
    },
    grade: (scene, a) => {
      const co = coEquip(scene);
      const t = blockageTarget(scene);
      const truth = co ? lineCrossesBuildings(scene, co.position, t.centroid, t.id) : [];
      return setEqual(a.buildingIds ?? [], truth);
    },
  },
  {
    // Mimics the agentic case (CL-L "in the middle of the road"): scan EVERY
    // closure/cabinet against EVERY street and flag the ones in the carriageway.
    // Tests whether the representation helps the search the data-only agent botched.
    id: "road_misplacement",
    category: "mixed",
    // The grading threshold is stated in the prompt (like onstreet's ~8m) — a
    // question must carry its own judgment criterion or it tests threshold
    // guessing, not spatial reading. Kept in sync with the oracle constant.
    prompt: () =>
      `Some equipment may be misplaced INTO a road — within ~${ORACLE_CONSTANTS.IN_ROAD_M}m of a ` +
      "street centerline (in the carriageway) instead of on a sidewalk or verge. List the ids of " +
      "every such equipment item (exclude the central office). Fill `equipmentIds` " +
      "(empty array if none).",
    grade: (scene, a) => setEqual(a.equipmentIds ?? [], equipmentInRoad(scene)),
  },
  {
    id: "enclosure",
    category: "mixed",
    prompt: () =>
      "List the ids of every building in the INTERIOR of the cluster — its centroid is NOT on the " +
      "outer perimeter (convex hull) of the buildings. Fill `buildingIds` (empty array if none).",
    grade: (scene, a) => setEqual(a.buildingIds ?? [], interiorBuildings(scene)),
  },
  {
    // Combines two primitive relations (nearest distance + street identity) in one
    // question — the canonical "mixed" task of the protocol.
    id: "nearest_offstreet",
    category: "mixed",
    prompt: (scene) => {
      const t = offstreetTargetBuilding(scene);
      return (
        `Consider building ${t}. Its "home street" is the street nearest to it. Which closure is ` +
        `nearest to ${t} among the closures whose OWN nearest street is a DIFFERENT street than ` +
        `${t}'s home street? Fill \`closureId\` with its id, or 'none' if every closure sits on ` +
        "the home street."
      );
    },
    grade: (scene, a) =>
      (a.closureId ?? "none") ===
      (nearestClosureOffStreet(scene, offstreetTargetBuilding(scene)) ?? "none"),
  },
];

// ---------------------------------------------------------------------------
// HOLD-OUT question set — the overfitting control.
//
// Written 2026-07-15, AFTER the textmap design was frozen at v2.5. None of these
// question types (counting, pairwise distance comparison, cardinal bearing,
// midpoint nearest, quadrant density, ordered ranking) was ever run during
// representation iteration. They are opt-in (questionIds: ["holdout"] or ho_*
// ids) so the frozen 10-question protocol is untouched, run ONCE, reported
// as-is. Target pickers are deterministic with margin guards so boundary
// degeneracies can't corrupt the oracle (lesson #3 in docs/textmap-v2.md).
// ---------------------------------------------------------------------------

/** First closure + the pair of buildings it must be compared against: nearest
 *  building vs the first building ≥ max(1.25×d, d+10m) away — a clear margin. */
function closerPair(scene: Scene): { eq: SceneEquipment; near: string; far: string } {
  const eq = scene.equipment.find((e) => e.kind === "closure") ?? scene.equipment[0];
  const sorted = [...scene.buildings].sort(
    (a, b) =>
      haversineMeters(eq.position, a.centroid) - haversineMeters(eq.position, b.centroid),
  );
  const near = sorted[0];
  const dNear = haversineMeters(eq.position, near.centroid);
  const far =
    sorted.find((b) => {
      const d = haversineMeters(eq.position, b.centroid);
      return d >= Math.max(dNear * 1.25, dNear + 10);
    }) ?? sorted[sorted.length - 1];
  return { eq, near: near.id, far: far.id };
}

/** Building with the LARGEST north–south separation from the first closure —
 *  the maximal-margin pick, so the bearing is never a coin flip. */
function bearingTarget(scene: Scene): { eq: SceneEquipment; buildingId: string } {
  const eq = scene.equipment.find((e) => e.kind === "closure") ?? scene.equipment[0];
  let best = scene.buildings[0];
  let bd = -1;
  for (const b of scene.buildings) {
    const d = Math.abs(eq.position[1] - b.centroid[1]);
    if (d > bd) {
      bd = d;
      best = b;
    }
  }
  return { eq, buildingId: best.id };
}

/** CO + the first closure whose midpoint has a UNIQUE nearest building (second
 *  nearest ≥ 1.15× away). Falls back to the first closure. */
function midpointPair(scene: Scene): { co: SceneEquipment; cl: SceneEquipment } {
  const co = coEquip(scene) ?? scene.equipment[0];
  const closures = scene.equipment.filter((e) => e.kind === "closure");
  for (const cl of closures) {
    const mid: [number, number] = [
      (co.position[0] + cl.position[0]) / 2,
      (co.position[1] + cl.position[1]) / 2,
    ];
    const ds = scene.buildings
      .map((b) => haversineMeters(mid, b.centroid))
      .sort((a, b) => a - b);
    if (ds.length >= 2 && ds[1] >= ds[0] * 1.15) return { co, cl };
  }
  return { co, cl: closures[0] ?? scene.equipment[0] };
}

export const HOLDOUT_QUESTIONS: Question[] = [
  {
    id: "ho_count_inside",
    category: "holdout",
    prompt: () =>
      "How many equipment items have their point INSIDE a building footprint? " +
      "Fill `count` with the number (0 if none).",
    grade: (scene, a) => a.count === closuresInsideBuildings(scene).length,
  },
  {
    id: "ho_closer",
    category: "holdout",
    prompt: (scene) => {
      const { eq, near, far } = closerPair(scene);
      // present in lexical order so the ordering never leaks the answer
      const [x, y] = [near, far].sort();
      return (
        `Which building's centroid is geographically NEARER to equipment ${eq.id}: ` +
        `${x} or ${y}? Fill \`buildingIds\` with exactly that one id.`
      );
    },
    grade: (scene, a) => {
      const { eq, near, far } = closerPair(scene);
      const truth = nearerBuildingOfPair(scene, eq.position, near, far);
      return setEqual(a.buildingIds ?? [], truth ? [truth] : []);
    },
  },
  {
    id: "ho_bearing",
    category: "holdout",
    prompt: (scene) => {
      const { eq, buildingId } = bearingTarget(scene);
      return (
        `Is equipment ${eq.id} NORTH or SOUTH of building ${buildingId}'s centroid? ` +
        "Fill `direction` with 'north' or 'south'."
      );
    },
    grade: (scene, a) => {
      const { eq, buildingId } = bearingTarget(scene);
      return (
        (a.direction ?? "").trim().toLowerCase() ===
        bearingNorthSouth(scene, eq.position, buildingId)
      );
    },
  },
  {
    id: "ho_midpoint",
    category: "holdout",
    prompt: (scene) => {
      const { co, cl } = midpointPair(scene);
      return (
        `Consider the midpoint of the straight segment from ${co.id} to ${cl.id}. ` +
        "Which building's centroid is nearest to that midpoint? Fill `buildingIds` " +
        "with exactly that one id."
      );
    },
    grade: (scene, a) => {
      const { co, cl } = midpointPair(scene);
      const truth = midpointNearestBuilding(scene, co.position, cl.position);
      return setEqual(a.buildingIds ?? [], truth ? [truth] : []);
    },
  },
  {
    id: "ho_quadrant",
    category: "holdout",
    prompt: () =>
      "Split the map into four quadrants (NE / NW / SE / SW) at the midpoint of its " +
      "bounds. Which quadrant contains the MOST building centroids? Fill `quadrant`.",
    // ties grade as "any argmax quadrant is correct"
    grade: (scene, a) =>
      densestQuadrants(scene).includes((a.quadrant ?? "").trim().toUpperCase()),
  },
  {
    id: "ho_rank3",
    category: "holdout",
    prompt: (scene) => {
      const co = coEquip(scene);
      return (
        `List the ids of the 3 buildings whose centroids are geographically nearest to ` +
        `${co?.id ?? "CO-1"}, ordered nearest first. Fill \`buildingIds\` with exactly ` +
        "3 ids in order."
      );
    },
    grade: (scene, a) => {
      const co = coEquip(scene);
      if (!co) return false;
      return orderedEqual(a.buildingIds ?? [], nearestKBuildings(scene, co.position, 3));
    },
  },
];

/** Every question, frozen protocol + hold-out — the engine resolves explicit
 *  questionIds against this; a null/empty filter still returns only QUESTIONS. */
export const ALL_QUESTIONS: Question[] = [...QUESTIONS, ...HOLDOUT_QUESTIONS];
