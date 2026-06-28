/**
 * Spatial-representation eval — canonical scene model + generators.
 *
 * A `Scene` is the SINGLE source of truth for a test world. Every
 * representation arm (JSON, ASCII text-twin, map image, verdict ledger) is
 * derived from the same Scene, so all arms describe a provably-identical world
 * and any accuracy difference is attributable to the representation, not the data.
 *
 * Synthetic scenes are authored in grid-space and projected to lng/lat, which
 * lets us plant known spatial errors (closure-in-building, cable crossing,
 * coverage gap) whose ground truth the oracle re-derives independently.
 */

import { nearestPointOnPolylines } from "./geo";

export type Coord = [number, number]; // [lng, lat]

export interface SceneBuilding {
  id: string;
  /** Closed polygon ring (first coord === last coord). */
  footprint: Coord[];
  centroid: Coord;
  type: "residential" | "commercial";
  floors: number;
  /** Street address (synthesized for synthetic scenes, from OSM for real ones). */
  address?: { number: string; street: string };
}

export interface SceneStreet {
  id: string;
  name: string;
  /** Polyline centerline. */
  coordinates: Coord[];
}

export type EquipmentKind = "co" | "cabinet" | "closure";

export interface SceneEquipment {
  id: string;
  kind: EquipmentKind;
  position: Coord;
  /** Building ids this equipment serves (closures only). */
  serves: string[];
}

export type CableKind = "feeder" | "distribution" | "drop";

export interface SceneCable {
  id: string;
  kind: CableKind;
  /** Equipment id. */
  sourceId: string;
  /** Equipment id OR building id (for drops). */
  targetId: string;
  /** Polyline path. */
  path: Coord[];
}

export interface SceneBounds {
  minLng: number;
  maxLng: number;
  minLat: number;
  maxLat: number;
}

export interface Scene {
  id: string;
  /** synthetic = invented grid drawn over an arbitrary basemap; real = real OSM
   *  geometry at real coordinates (so a basemap render matches it). */
  kind: "synthetic" | "real";
  bounds: SceneBounds;
  buildings: SceneBuilding[];
  streets: SceneStreet[];
  equipment: SceneEquipment[];
  cables: SceneCable[];
  /** Present only for synthetic scenes. */
  grid?: { cols: number; rows: number; metersPerCell: number; origin: Coord };
  /** What was deliberately planted — for test assertions only, NOT shown to the model. */
  planted: {
    closuresInBuilding: string[]; // equipment ids
    crossingCables: string[]; // cable ids
    coverageGap: boolean;
    closuresOnStreet: string[]; // equipment ids moved into a road
  };
}

// ---------------------------------------------------------------------------
// Coordinate projection (grid cell -> lng/lat)
// ---------------------------------------------------------------------------

const M_PER_DEG_LAT = 110540;
function mPerDegLng(lat: number): number {
  return 111320 * Math.cos((lat * Math.PI) / 180);
}

interface GridProjector {
  cols: number;
  rows: number;
  metersPerCell: number;
  origin: Coord;
  /** Cell (col,row) center -> [lng,lat]. row 0 is the SOUTH edge. */
  cell: (col: number, row: number) => Coord;
}

function makeProjector(
  cols: number,
  rows: number,
  metersPerCell: number,
  origin: Coord,
): GridProjector {
  const [oLng, oLat] = origin;
  const dLng = metersPerCell / mPerDegLng(oLat);
  const dLat = metersPerCell / M_PER_DEG_LAT;
  return {
    cols,
    rows,
    metersPerCell,
    origin,
    cell: (col, row) => [oLng + (col + 0.5) * dLng, oLat + (row + 0.5) * dLat],
  };
}

// ---------------------------------------------------------------------------
// Deterministic PRNG (so a (seed) reproduces an identical scene)
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Synthetic scene generator
// ---------------------------------------------------------------------------

export interface SyntheticSpec {
  id: string;
  seed: number;
  /** Number of building blocks horizontally / vertically. */
  blocksX?: number;
  blocksY?: number;
  metersPerCell?: number;
  origin?: Coord;
  plant?: {
    closureInBuilding?: boolean;
    cableCrossing?: boolean;
    coverageGap?: boolean;
    closureOnStreet?: boolean;
  };
}

/** Closure id letters (CL-A, CL-B, …) — match the map/grid markers; ≤26 closures. */
export const CLOSURE_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

const BLOCK_W = 4; // building cells wide
const BLOCK_H = 4; // building cells tall
const MARGIN = 1; // street gutter cells around each block

/** Region (in cells) a single block occupies, including its surrounding streets. */
function blockRegion(bx: number, by: number): { c0: number; r0: number } {
  const pitchX = BLOCK_W + MARGIN;
  const pitchY = BLOCK_H + MARGIN;
  return { c0: MARGIN + bx * pitchX, r0: MARGIN + by * pitchY };
}

function rectFootprint(p: GridProjector, c0: number, r0: number, w: number, h: number): Coord[] {
  // Build a closed ring from the outer corners of the cell rectangle.
  const sw = p.cell(c0 - 0.5, r0 - 0.5);
  const se = p.cell(c0 + w - 0.5, r0 - 0.5);
  const ne = p.cell(c0 + w - 0.5, r0 + h - 0.5);
  const nw = p.cell(c0 - 0.5, r0 + h - 0.5);
  return [sw, se, ne, nw, sw];
}

function centroidOf(ring: Coord[]): Coord {
  let lng = 0;
  let lat = 0;
  const n = ring.length - 1; // last === first
  for (let i = 0; i < n; i++) {
    lng += ring[i][0];
    lat += ring[i][1];
  }
  return [lng / n, lat / n];
}

export function makeSyntheticScene(spec: SyntheticSpec): Scene {
  const blocksX = spec.blocksX ?? 3;
  const blocksY = spec.blocksY ?? 3;
  const metersPerCell = spec.metersPerCell ?? 10;
  const origin = spec.origin ?? [34.78, 32.085];
  const rand = mulberry32(spec.seed);

  const pitchX = BLOCK_W + MARGIN;
  const pitchY = BLOCK_H + MARGIN;
  const cols = MARGIN + blocksX * pitchX;
  const rows = MARGIN + blocksY * pitchY;
  const p = makeProjector(cols, rows, metersPerCell, origin);

  const buildings: SceneBuilding[] = [];
  const streets: SceneStreet[] = [];
  const equipment: SceneEquipment[] = [];
  const cables: SceneCable[] = [];

  // --- Streets: a grid of horizontal + vertical centerlines in the gutters ---
  for (let by = 0; by <= blocksY; by++) {
    const row = by === 0 ? 0 : MARGIN + by * pitchY - 1;
    streets.push({
      id: `st-h-${by}`,
      name: `H Street ${by}`,
      coordinates: [p.cell(0, row), p.cell(cols - 1, row)],
    });
  }
  for (let bx = 0; bx <= blocksX; bx++) {
    const col = bx === 0 ? 0 : MARGIN + bx * pitchX - 1;
    streets.push({
      id: `st-v-${bx}`,
      name: `V Street ${bx}`,
      coordinates: [p.cell(col, 0), p.cell(col, rows - 1)],
    });
  }

  // --- Buildings: one rectangle per block ---
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const { c0, r0 } = blockRegion(bx, by);
      const ring = rectFootprint(p, c0, r0, BLOCK_W, BLOCK_H);
      buildings.push({
        id: `B-${bx}-${by}`,
        footprint: ring,
        centroid: centroidOf(ring),
        type: rand() < 0.25 ? "commercial" : "residential",
        floors: 3 + Math.floor(rand() * 8),
        // Deterministic synthetic address: even house numbers down the H street
        // that borders this block. Computed (not rand()) so existing seeds are
        // unchanged except for the new field.
        address: {
          number: String((bx + by * blocksX + 1) * 2),
          street: `H Street ${by}`,
        },
      });
    }
  }

  // --- A CO at the south-west street corner ---
  const co: SceneEquipment = { id: "CO-1", kind: "co", position: p.cell(0, 0), serves: [] };
  equipment.push(co);

  // --- One closure per block, placed on the street just south of the block ---
  const plantGap = spec.plant?.coverageGap ?? false;
  // Use the top-right corner building so the gap is far from every other closure.
  const gapIndex = plantGap ? buildings.length - 1 : -1;

  // Closures are lettered (CL-A, CL-B, …) in creation order so the id matches the
  // map/grid marker exactly (buildings stay numeric: B-0). cli is the push order.
  let cli = 0;
  buildings.forEach((b, i) => {
    if (i === gapIndex) return; // leave this building with no closure (coverage gap)
    const [bx, by] = [i % blocksX, Math.floor(i / blocksX)];
    const { c0, r0 } = blockRegion(bx, by);
    // street cell just south of the block (on the horizontal street line)
    const streetRow = r0 - 1;
    const streetCol = c0 + Math.floor(BLOCK_W / 2);
    const onStreet = p.cell(streetCol, streetRow);
    // Nudge ~12% toward the building centroid so each closure is unambiguously
    // nearest its OWN building (breaks the regular grid's equidistance ties).
    // Small enough (~3m) to remain on-street.
    const t = 0.12;
    const closure: SceneEquipment = {
      id: `CL-${CLOSURE_LETTERS[cli] ?? cli}`,
      kind: "closure",
      position: [
        onStreet[0] + (b.centroid[0] - onStreet[0]) * t,
        onStreet[1] + (b.centroid[1] - onStreet[1]) * t,
      ],
      serves: [b.id],
    };
    cli++;
    equipment.push(closure);
    // drop cable closure -> building centroid (short, perpendicular to street)
    cables.push({
      id: `drop-${closure.id}`,
      kind: "drop",
      sourceId: closure.id,
      targetId: b.id,
      path: [closure.position, b.centroid],
    });
  });

  // --- Plant: move one closure INTO its building footprint ---
  const closuresInBuilding: string[] = [];
  if (spec.plant?.closureInBuilding) {
    const closure = equipment.find((e) => e.kind === "closure");
    if (closure) {
      const served = buildings.find((b) => b.id === closure.serves[0]);
      if (served) {
        closure.position = served.centroid; // now inside the footprint
        closuresInBuilding.push(closure.id);
      }
    }
  }

  // --- Plant: a distribution cable that crosses a non-served building ---
  const crossingCables: string[] = [];
  if (spec.plant?.cableCrossing && equipment.length >= 3) {
    const closures = equipment.filter((e) => e.kind === "closure");
    if (closures.length >= 2) {
      const a = closures[0];
      const b = closures[closures.length - 1];
      // straight line between two far closures will pass through interior blocks
      const cable: SceneCable = {
        id: "dist-cross",
        kind: "distribution",
        sourceId: a.id,
        targetId: b.id,
        path: [a.position, b.position],
      };
      cables.push(cable);
      crossingCables.push(cable.id);
    }
  }

  // --- Plant: move the LAST closure into the carriageway (on a street centerline) ---
  const closuresOnStreet: string[] = [];
  if (spec.plant?.closureOnStreet) {
    const closures = equipment.filter((e) => e.kind === "closure");
    const cl = closures[closures.length - 1];
    if (cl && streets.length > 0) {
      cl.position = nearestPointOnPolylines(
        cl.position,
        streets.map((s) => s.coordinates),
      );
      closuresOnStreet.push(cl.id);
    }
  }

  return {
    id: spec.id,
    kind: "synthetic",
    bounds: {
      minLng: p.cell(-0.5, -0.5)[0],
      minLat: p.cell(-0.5, -0.5)[1],
      maxLng: p.cell(cols - 0.5, rows - 0.5)[0],
      maxLat: p.cell(cols - 0.5, rows - 0.5)[1],
    },
    buildings,
    streets,
    equipment,
    cables,
    grid: { cols, rows, metersPerCell, origin },
    planted: { closuresInBuilding, crossingCables, coverageGap: plantGap, closuresOnStreet },
  };
}
