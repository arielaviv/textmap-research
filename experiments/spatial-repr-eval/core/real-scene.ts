/**
 * Builds a Scene from REAL OSM geometry (buildings + streets) so the rendered
 * map matches the basemap and the test runs on real footprints. The OSM fetch
 * (osmStreetService.fetchStreetsFromOSM) happens in the API route; this pure
 * builder takes the raw features and places equipment + planted errors on them.
 *
 * Only the network (CO, closures, cables) is generated; buildings and streets
 * are the real OSM data, and the oracle grades against the real footprints.
 */

import { haversineMeters, nearestPointOnPolylines, polygonCentroid } from "./geo";
import { CLOSURE_LETTERS } from "./scene";
import type { Coord, Scene, SceneBuilding, SceneCable, SceneEquipment, SceneStreet } from "./scene";

export interface RawBuilding {
  id: string;
  geometry: Coord[]; // ring [lng,lat][]
  address?: { number?: string; street?: string };
}
export interface RawStreet {
  id: string;
  name?: string;
  geometry: Coord[];
}
export interface RealSceneInput {
  id: string;
  buildings: RawBuilding[];
  streets: RawStreet[];
  maxBuildings?: number;
  plant?: {
    closureInBuilding?: boolean;
    cableCrossing?: boolean;
    coverageGap?: boolean;
    closureOnStreet?: boolean;
  };
}

function boundsOf(coords: Coord[]): Scene["bounds"] {
  let minLng = Number.POSITIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  for (const [lng, lat] of coords) {
    if (lng < minLng) minLng = lng;
    if (lat < minLat) minLat = lat;
    if (lng > maxLng) maxLng = lng;
    if (lat > maxLat) maxLat = lat;
  }
  return { minLng, minLat, maxLng, maxLat };
}

export function buildRealScene(input: RealSceneInput): Scene {
  const cap = Math.max(1, Math.min(input.maxBuildings ?? 12, 40));

  // Keep only valid rings, compute centroids.
  const all = input.buildings
    .filter((b) => b.geometry.length >= 3)
    .map((b) => ({
      id: b.id,
      ring: b.geometry,
      centroid: polygonCentroid(b.geometry),
      address: b.address,
    }));

  if (all.length === 0) {
    throw new Error("no buildings in this area — try another seed/city");
  }

  // Pick the `cap` buildings nearest the overall centroid (a compact cluster).
  const center: Coord = [
    all.reduce((s, b) => s + b.centroid[0], 0) / all.length,
    all.reduce((s, b) => s + b.centroid[1], 0) / all.length,
  ];
  // Nearest-first, but skip near-coincident footprints (OSM often has
  // overlapping building/building-part polygons) so every building is a
  // visually distinct pin/cell — no two stacked on the same spot.
  const MIN_SEP_M = 8;
  const sorted = [...all].sort(
    (a, b) => haversineMeters(a.centroid, center) - haversineMeters(b.centroid, center),
  );
  const chosen: typeof sorted = [];
  for (const b of sorted) {
    if (chosen.length >= cap) break;
    if (chosen.some((c) => haversineMeters(c.centroid, b.centroid) < MIN_SEP_M)) continue;
    chosen.push(b);
  }

  const buildings: SceneBuilding[] = chosen.map((b, i) => ({
    id: `B-${i}`,
    footprint: b.ring,
    centroid: b.centroid,
    type: i % 4 === 0 ? "commercial" : "residential",
    floors: 3 + (i % 8),
    ...(b.address?.number
      ? { address: { number: b.address.number, street: b.address.street ?? "" } }
      : {}),
  }));

  // Keep streets that pass near the chosen cluster (within the cluster bbox + margin).
  const clusterBounds = boundsOf(buildings.flatMap((b) => b.footprint));
  const m = 0.002; // ~200m margin in degrees
  const streetLines: Coord[][] = [];
  const streets: SceneStreet[] = [];
  for (const s of input.streets) {
    if (s.geometry.length < 2) continue;
    const near = s.geometry.some(
      ([lng, lat]) =>
        lng >= clusterBounds.minLng - m &&
        lng <= clusterBounds.maxLng + m &&
        lat >= clusterBounds.minLat - m &&
        lat <= clusterBounds.maxLat + m,
    );
    if (!near) continue;
    streets.push({
      id: `st-${streets.length}`,
      name: s.name ?? `street ${streets.length}`,
      coordinates: s.geometry,
    });
    streetLines.push(s.geometry);
    if (streets.length >= 60) break;
  }

  const snap = (pt: Coord): Coord =>
    streetLines.length ? nearestPointOnPolylines(pt, streetLines) : pt;

  // CO at the street nearest the SW corner of the cluster.
  const swCorner: Coord = [clusterBounds.minLng, clusterBounds.minLat];
  const equipment: SceneEquipment[] = [
    { id: "CO-1", kind: "co", position: snap(swCorner), serves: [] },
  ];
  const cables: SceneCable[] = [];

  // Coverage-gap plant: drop the closure for the most isolated building.
  let gapIdx = -1;
  if (input.plant?.coverageGap && buildings.length > 1) {
    let bestD = -1;
    buildings.forEach((b, i) => {
      let nearest = Number.POSITIVE_INFINITY;
      buildings.forEach((o, j) => {
        if (i === j) return;
        const d = haversineMeters(b.centroid, o.centroid);
        if (d < nearest) nearest = d;
      });
      if (nearest > bestD) {
        bestD = nearest;
        gapIdx = i;
      }
    });
  }

  // Closures lettered (CL-A, CL-B, …) in creation order so the id matches the
  // map/grid marker (buildings stay numeric: B-0). cli = closure push order.
  let cli = 0;
  buildings.forEach((b, i) => {
    if (i === gapIdx) return;
    const closure: SceneEquipment = {
      id: `CL-${CLOSURE_LETTERS[cli] ?? cli}`,
      kind: "closure",
      position: snap(b.centroid),
      serves: [b.id],
    };
    cli++;
    equipment.push(closure);
    cables.push({
      id: `drop-${closure.id}`,
      kind: "drop",
      sourceId: closure.id,
      targetId: b.id,
      path: [closure.position, b.centroid],
    });
  });

  const planted = {
    closuresInBuilding: [] as string[],
    crossingCables: [] as string[],
    coverageGap: !!input.plant?.coverageGap,
    closuresOnStreet: [] as string[],
  };

  if (input.plant?.closureInBuilding) {
    const cl = equipment.find((e) => e.kind === "closure");
    const served = cl && buildings.find((b) => b.id === cl.serves[0]);
    if (cl && served) {
      cl.position = served.centroid;
      planted.closuresInBuilding.push(cl.id);
    }
  }

  if (input.plant?.cableCrossing) {
    const closures = equipment.filter((e) => e.kind === "closure");
    if (closures.length >= 2) {
      const a = closures[0];
      const b = closures[closures.length - 1];
      cables.push({
        id: "dist-cross",
        kind: "distribution",
        sourceId: a.id,
        targetId: b.id,
        path: [a.position, b.position],
      });
      planted.crossingCables.push("dist-cross");
    }
  }

  if (input.plant?.closureOnStreet) {
    const closures = equipment.filter((e) => e.kind === "closure");
    const cl = closures[closures.length - 1];
    if (cl && streets.length > 0) {
      cl.position = nearestPointOnPolylines(
        cl.position,
        streets.map((s) => s.coordinates),
      );
      planted.closuresOnStreet.push(cl.id);
    }
  }

  // Frame the grid on the building cluster (+ equipment), NOT the streets —
  // long streets would sprawl the bounds and make the ASCII grid coarse.
  const bounds = boundsOf([
    ...buildings.flatMap((b) => b.footprint),
    ...equipment.map((e) => e.position),
  ]);

  return { id: input.id, kind: "real", bounds, buildings, streets, equipment, cables, planted };
}

// ---------------------------------------------------------------------------
// City → AOI bbox (deterministic from a seed) for the OSM fetch
// ---------------------------------------------------------------------------

const CITY_CENTERS: Record<string, Coord> = {
  "tel-aviv": [34.7806, 32.0809],
  nyc: [-73.984, 40.7549],
};

export function cityList(): string[] {
  return Object.keys(CITY_CENTERS);
}

/** A ~350m AOI around the city center, jittered by seed so different seeds sample different blocks. */
export function aoiForCity(
  city: string,
  seed: number,
): { minLat: number; minLon: number; maxLat: number; maxLon: number } {
  const center = CITY_CENTERS[city] ?? CITY_CENTERS.nyc;
  // deterministic small jitter from seed (±~1km)
  const jLng = (((seed * 73) % 100) / 100 - 0.5) * 0.02;
  const jLat = (((seed * 91) % 100) / 100 - 0.5) * 0.02;
  const lng = center[0] + jLng;
  const lat = center[1] + jLat;
  const half = 0.00175; // ~350m total box
  return { minLon: lng - half, maxLon: lng + half, minLat: lat - half, maxLat: lat + half };
}
