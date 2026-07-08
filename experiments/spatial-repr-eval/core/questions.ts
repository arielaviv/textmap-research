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
  cablesCrossingForeignBuildings,
  closuresInsideBuildings,
  coverageGapBuildings,
  equipmentInRoad,
  interiorBuildings,
  isOnStreet,
  lineCrossesBuildings,
  nearestClosureOffStreet,
  nearestClosureToBuilding,
  nearestStreetIsNamed,
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
  | "mixed";

export interface Answer {
  equipmentIds?: string[];
  cableIds?: string[];
  buildingIds?: string[];
  closureId?: string;
  onStreet?: boolean;
  equipmentPath?: string[];
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
    prompt: () =>
      "Some equipment may be misplaced INTO a road — sitting on a street centerline / in the " +
      "carriageway instead of on a sidewalk or verge. List the ids of every such equipment item " +
      "(exclude the central office). Fill `equipmentIds` (empty array if none).",
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
