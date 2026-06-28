/**
 * Deterministic obstacle-avoiding router. The LLM decides WHAT to connect
 * (intent: from-id → to-id); this computes HOW — an exact path on a fine grid
 * that avoids the REAL building footprints, prefers open space off the carriageway, and
 * crosses streets only when necessary. The LLM is good at the gestalt ("go
 * around that building"); geometry is good at the precise waypoints. Hybrid.
 *
 * Pure (geo + scene only).
 */

import { haversineMeters, pointInPolygon, pointToPolylineMeters } from "./geo";
import type { Coord, Scene } from "./scene";

const CELL_M = 2.5; // routing grid resolution (finer than the textmap's ~5m)
const CLEARANCE_M = 1.8; // keep paths this far off building footprints (no grazing)
const STREET_COST = 6; // discourage running along/over streets (prefer off-carriageway)
const MAX_CELLS = 140; // cap grid dimension so the search stays cheap

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** An obstacle-avoiding path (lng/lat, simplified to turns) from `from` to `to`,
 *  or null if no route exists. Endpoints are snapped to the exact inputs. */
export function routePath(scene: Scene, from: Coord, to: Coord): Coord[] | null {
  const { minLng, minLat, maxLng, maxLat } = scene.bounds;
  const widthM = Math.max(1, haversineMeters([minLng, minLat], [maxLng, minLat]));
  const heightM = Math.max(1, haversineMeters([minLng, minLat], [minLng, maxLat]));
  const gw = clamp(Math.round(widthM / CELL_M), 8, MAX_CELLS);
  const gh = clamp(Math.round(heightM / CELL_M), 8, MAX_CELLS);
  const cellW = (maxLng - minLng) / gw || 1;
  const cellH = (maxLat - minLat) / gh || 1;

  const cellToCoord = (col: number, row: number): Coord => [
    minLng + (col + 0.5) * cellW,
    minLat + (row + 0.5) * cellH,
  ];
  const coordToCell = (c: Coord): [number, number] => [
    clamp(Math.floor((c[0] - minLng) / cellW), 0, gw - 1),
    clamp(Math.floor((c[1] - minLat) / cellH), 0, gh - 1),
  ];

  // Classify every cell against the REAL geometry (not the coarse textmap).
  const isBlocked: boolean[][] = [];
  const isStreet: boolean[][] = [];
  for (let r = 0; r < gh; r++) {
    isBlocked[r] = [];
    isStreet[r] = [];
    for (let c = 0; c < gw; c++) {
      const p = cellToCoord(c, r);
      // Blocked if inside a footprint OR within a small clearance of its edge,
      // so routed segments never graze a building.
      const blocked = scene.buildings.some(
        (b) => pointInPolygon(p, b.footprint) || pointToPolylineMeters(p, b.footprint) < CLEARANCE_M,
      );
      isBlocked[r][c] = blocked;
      isStreet[r][c] =
        !blocked && scene.streets.some((s) => pointToPolylineMeters(p, s.coordinates) < CELL_M * 1.6);
    }
  }

  // Snap start/goal to the nearest accessible (non-building) cell — a target
  // building's centroid is inside its footprint, so route to its edge and let
  // the final/first leg connect to the exact point.
  const nearestFree = (c0: number, r0: number): [number, number] => {
    if (!isBlocked[r0][c0]) return [c0, r0];
    for (let rad = 1; rad < Math.max(gw, gh); rad++) {
      for (let dy = -rad; dy <= rad; dy++) {
        for (let dx = -rad; dx <= rad; dx++) {
          const c = c0 + dx;
          const r = r0 + dy;
          if (c >= 0 && c < gw && r >= 0 && r < gh && !isBlocked[r][c]) return [c, r];
        }
      }
    }
    return [c0, r0];
  };
  const [sc, sr] = nearestFree(...coordToCell(from));
  const [tc, tr] = nearestFree(...coordToCell(to));
  const idx = (c: number, r: number): number => r * gw + c;
  const start = idx(sc, sr);
  const goal = idx(tc, tr);

  // A* (8-connected); building cells are impassable except the goal cell.
  const open = new Set<number>([start]);
  const came = new Map<number, number>();
  const g = new Map<number, number>([[start, 0]]);
  const heur = (c: number, r: number): number => Math.hypot(c - tc, r - tr);
  const f = new Map<number, number>([[start, heur(sc, sr)]]);
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];
  let found = false;
  let iter = 0;
  const maxIter = gw * gh * 4;
  while (open.size > 0 && iter++ < maxIter) {
    let cur = -1;
    let bestF = Number.POSITIVE_INFINITY;
    for (const n of open) {
      const fv = f.get(n) ?? Number.POSITIVE_INFINITY;
      if (fv < bestF) {
        bestF = fv;
        cur = n;
      }
    }
    if (cur === goal) {
      found = true;
      break;
    }
    open.delete(cur);
    const cc = cur % gw;
    const cr = Math.floor(cur / gw);
    for (const [dx, dy] of dirs) {
      const nc = cc + dx;
      const nr = cr + dy;
      if (nc < 0 || nc >= gw || nr < 0 || nr >= gh) continue;
      const isEndpoint = nc === tc && nr === tr;
      if (isBlocked[nr][nc] && !isEndpoint) continue;
      const isDiag = Math.abs(dx) + Math.abs(dy) === 2;
      // No diagonal corner-cutting between two blocked cells.
      if (isDiag && (isBlocked[cr][nc] || isBlocked[nr][cc])) continue;
      const diag = isDiag ? 1.4142 : 1;
      const step = diag * (isStreet[nr][nc] ? STREET_COST : 1);
      const nk = idx(nc, nr);
      const ng = (g.get(cur) ?? Number.POSITIVE_INFINITY) + step;
      if (ng < (g.get(nk) ?? Number.POSITIVE_INFINITY)) {
        came.set(nk, cur);
        g.set(nk, ng);
        f.set(nk, ng + heur(nc, nr));
        open.add(nk);
      }
    }
  }
  if (!found) return null;

  // Reconstruct cell path goal→start, then reverse.
  const cells: [number, number][] = [];
  let cur = goal;
  while (cur !== start) {
    cells.push([cur % gw, Math.floor(cur / gw)]);
    const prev = came.get(cur);
    if (prev === undefined) break;
    cur = prev;
  }
  cells.push([sc, sr]);
  cells.reverse();

  // Cells → coords, then drop collinear points (keep only the turns).
  const coords = cells.map(([c, r]) => cellToCoord(c, r));
  const simplified: Coord[] = [];
  for (let i = 0; i < coords.length; i++) {
    if (i === 0 || i === coords.length - 1) {
      simplified.push(coords[i]);
      continue;
    }
    const a = coords[i - 1];
    const b = coords[i];
    const d = coords[i + 1];
    const cross = (b[0] - a[0]) * (d[1] - b[1]) - (b[1] - a[1]) * (d[0] - b[0]);
    if (Math.abs(cross) > 1e-12) simplified.push(b); // a turn
  }
  // Snap endpoints to the exact entity coordinates.
  simplified[0] = from;
  simplified[simplified.length - 1] = to;
  return simplified;
}
