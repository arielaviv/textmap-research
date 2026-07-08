/**
 * Spatial-representation eval — deterministic ground-truth oracle.
 *
 * Computes the TRUE answer to each spatial question directly from Scene
 * geometry (via the dependency-free `geo` module). This is the grading
 * authority: it is unit-verified against scenes with hand-known answers
 * (`verify-oracle.ts` / `__tests__/oracle.test.ts`). It never sees model
 * output and never reads `scene.planted`.
 */

import {
  convexHull,
  haversineMeters,
  pointInPolygon,
  pointToPolylineMeters,
  polylineIntersectsPolygon,
} from "./geo";
import type { Coord, Scene } from "./scene";

const ON_STREET_SNAP_M = 8; // within 8m of a street centerline counts as "on street"
const COVERAGE_RADIUS_M = 35; // a building is "covered" if a closure is within 35m
// Within 2m of a centerline = sitting IN the carriageway (misplaced). 2, not 3:
// the synthetic generator places every closure at exactly 3.0m offset, so a ≤3
// threshold made the whole roster "in road" by boundary equality — degenerate.
const IN_ROAD_M = 2;

/** Equipment ids whose point falls inside a building footprint (an error). */
export function closuresInsideBuildings(scene: Scene): string[] {
  const out: string[] = [];
  for (const e of scene.equipment) {
    if (scene.buildings.some((b) => pointInPolygon(e.position, b.footprint))) {
      out.push(e.id);
    }
  }
  return out;
}

/** Cable ids whose path passes through a building footprint it does NOT terminate at. */
export function cablesCrossingForeignBuildings(scene: Scene): string[] {
  const out: string[] = [];
  for (const c of scene.cables) {
    const excluded = new Set<string>();
    if (c.kind === "drop") excluded.add(c.targetId); // a drop legitimately ends in its building
    const crosses = scene.buildings.some(
      (b) => !excluded.has(b.id) && polylineIntersectsPolygon(c.path, b.footprint),
    );
    if (crosses) out.push(c.id);
  }
  return out;
}

/** Distance (m) from an equipment point to the nearest street centerline. */
export function distanceToNearestStreet(scene: Scene, equipmentId: string): number {
  const e = scene.equipment.find((x) => x.id === equipmentId);
  if (!e) return Number.POSITIVE_INFINITY;
  let min = Number.POSITIVE_INFINITY;
  for (const s of scene.streets) {
    const d = pointToPolylineMeters(e.position, s.coordinates);
    if (d < min) min = d;
  }
  return min;
}

export function isOnStreet(scene: Scene, equipmentId: string): boolean {
  return distanceToNearestStreet(scene, equipmentId) <= ON_STREET_SNAP_M;
}

/** Closure id nearest to a building centroid. */
export function nearestClosureToBuilding(scene: Scene, buildingId: string): string | null {
  const b = scene.buildings.find((x) => x.id === buildingId);
  if (!b) return null;
  let best: { id: string; d: number } | null = null;
  for (const e of scene.equipment) {
    if (e.kind !== "closure") continue;
    const d = haversineMeters(b.centroid, e.position);
    if (!best || d < best.d) best = { id: e.id, d };
  }
  return best?.id ?? null;
}

/** Building ids with no closure within COVERAGE_RADIUS_M (coverage gap). */
export function coverageGapBuildings(scene: Scene): string[] {
  const closures = scene.equipment.filter((e) => e.kind === "closure");
  const out: string[] = [];
  for (const b of scene.buildings) {
    const covered = closures.some(
      (c) => haversineMeters(b.centroid, c.position) <= COVERAGE_RADIUS_M,
    );
    if (!covered) out.push(b.id);
  }
  return out;
}

/** Ordered equipment ids on the path from a building to the source (nearest-first). */
export function pathToSource(scene: Scene, buildingId: string): string[] {
  const serving = scene.equipment.find(
    (e) => e.kind === "closure" && e.serves.includes(buildingId),
  );
  const co = scene.equipment.find((e) => e.kind === "co");
  const path: string[] = [];
  if (serving) path.push(serving.id);
  if (co) path.push(co.id);
  return path;
}

/** Buildings whose footprint a straight line from→to passes through (excluding one). */
export function lineCrossesBuildings(
  scene: Scene,
  from: Coord,
  to: Coord,
  excludeBuildingId?: string,
): string[] {
  return scene.buildings
    .filter(
      (b) => b.id !== excludeBuildingId && polylineIntersectsPolygon([from, to], b.footprint),
    )
    .map((b) => b.id);
}

/**
 * Equipment ids sitting IN a road — within IN_ROAD_M of a street centerline, i.e.
 * misplaced into the carriageway rather than on a sidewalk/verge. Excludes the CO
 * (a facility, not a street-mounted device). Requires scanning ALL equipment
 * against ALL streets — the "agentic search" task.
 */
export function equipmentInRoad(scene: Scene): string[] {
  const out: string[] = [];
  for (const e of scene.equipment) {
    if (e.kind === "co") continue;
    let min = Number.POSITIVE_INFINITY;
    for (const s of scene.streets) {
      const d = pointToPolylineMeters(e.position, s.coordinates);
      if (d < min) min = d;
    }
    if (min <= IN_ROAD_M) out.push(e.id);
  }
  return out;
}

/** True when a street name is a real name (not the real-scene "street N" placeholder
 *  for unnamed OSM ways — the same test the textmap legend applies). */
function isRealStreetName(name: string): boolean {
  const nm = name.trim();
  return nm.length > 0 && !/^street \d+$/i.test(nm);
}

/** Identity of the street nearest to a position: the street NAME when real (so a
 *  multi-segment street counts as ONE street), else the segment id. */
export function nearestStreetName(scene: Scene, pos: Coord): string | null {
  let best: { key: string; d: number } | null = null;
  for (const s of scene.streets) {
    if (s.coordinates.length < 2) continue;
    const d = pointToPolylineMeters(pos, s.coordinates);
    if (!best || d < best.d) {
      best = { key: isRealStreetName(s.name) ? s.name.trim() : s.id, d };
    }
  }
  return best?.key ?? null;
}

/** True when the street nearest `pos` carries a real name. */
export function nearestStreetIsNamed(scene: Scene, pos: Coord): boolean {
  let best: { named: boolean; d: number } | null = null;
  for (const s of scene.streets) {
    if (s.coordinates.length < 2) continue;
    const d = pointToPolylineMeters(pos, s.coordinates);
    if (!best || d < best.d) best = { named: isRealStreetName(s.name), d };
  }
  return best?.named ?? false;
}

/** Nearest closure to a building whose nearest street DIFFERS from the building's —
 *  the "mixed" question (nearest-distance + street-identity combined). */
export function nearestClosureOffStreet(scene: Scene, buildingId: string): string | null {
  const b = scene.buildings.find((x) => x.id === buildingId);
  if (!b) return null;
  const home = nearestStreetName(scene, b.centroid);
  let best: { id: string; d: number } | null = null;
  for (const e of scene.equipment) {
    if (e.kind !== "closure") continue;
    if (nearestStreetName(scene, e.position) === home) continue;
    const d = haversineMeters(b.centroid, e.position);
    if (!best || d < best.d) best = { id: e.id, d };
  }
  return best?.id ?? null;
}

/** Buildings in the interior of the cluster — centroid NOT on the convex hull. */
export function interiorBuildings(scene: Scene): string[] {
  if (scene.buildings.length < 4) return [];
  const hull = convexHull(scene.buildings.map((b) => b.centroid));
  const onHull = new Set(hull.map((p) => `${p[0]},${p[1]}`));
  return scene.buildings
    .filter((b) => !onHull.has(`${b.centroid[0]},${b.centroid[1]}`))
    .map((b) => b.id);
}

export const ORACLE_CONSTANTS = { ON_STREET_SNAP_M, COVERAGE_RADIUS_M, IN_ROAD_M };
