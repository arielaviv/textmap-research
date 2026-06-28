/**
 * Dependency-free planar geometry for the eval oracle.
 *
 * Deliberately NO turf import: the eval core must run in the lightweight Node
 * path (pnpm's junction layout makes transitive deps unresolvable there), and
 * these predicates are simple enough to implement exactly. At city scale an
 * equirectangular local projection is accurate to well under a meter, which is
 * far finer than any spatial question we grade.
 */

export type Coord = [number, number]; // [lng, lat]

const M_PER_DEG_LAT = 110540;
function mPerDegLng(lat: number): number {
  return 111320 * Math.cos((lat * Math.PI) / 180);
}

/** Project lng/lat to local meters around a reference latitude. */
function toXY(c: Coord, refLat: number): [number, number] {
  return [c[0] * mPerDegLng(refLat), c[1] * M_PER_DEG_LAT];
}

export function haversineMeters(a: Coord, b: Coord): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Ray-casting point-in-polygon. `ring` is a closed ring [lng,lat][]. */
export function pointInPolygon(pt: Coord, ring: Coord[]): boolean {
  const [x, y] = pt;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function ccw(a: [number, number], b: [number, number], c: [number, number]): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

/** Do segments p1p2 and p3p4 properly intersect (planar)? */
export function segmentsIntersect(
  p1: Coord,
  p2: Coord,
  p3: Coord,
  p4: Coord,
  refLat: number,
): boolean {
  const a = toXY(p1, refLat);
  const b = toXY(p2, refLat);
  const c = toXY(p3, refLat);
  const d = toXY(p4, refLat);
  const d1 = ccw(c, d, a);
  const d2 = ccw(c, d, b);
  const d3 = ccw(a, b, c);
  const d4 = ccw(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  return false;
}

/** Does a polyline path intersect a polygon (cross an edge OR have a vertex inside)? */
export function polylineIntersectsPolygon(path: Coord[], ring: Coord[]): boolean {
  const refLat = ring[0][1];
  // Any path vertex inside the polygon.
  if (path.some((p) => pointInPolygon(p, ring))) return true;
  // Any path segment crossing any polygon edge.
  for (let i = 0; i < path.length - 1; i++) {
    for (let j = 0; j < ring.length - 1; j++) {
      if (segmentsIntersect(path[i], path[i + 1], ring[j], ring[j + 1], refLat)) return true;
    }
  }
  return false;
}

/** Distance (m) from a point to a segment. */
function pointToSegmentMeters(pt: Coord, a: Coord, b: Coord, refLat: number): number {
  const p = toXY(pt, refLat);
  const v = toXY(a, refLat);
  const w = toXY(b, refLat);
  const l2 = (w[0] - v[0]) ** 2 + (w[1] - v[1]) ** 2;
  if (l2 === 0) return Math.hypot(p[0] - v[0], p[1] - v[1]);
  let t = ((p[0] - v[0]) * (w[0] - v[0]) + (p[1] - v[1]) * (w[1] - v[1])) / l2;
  t = Math.max(0, Math.min(1, t));
  const proj = [v[0] + t * (w[0] - v[0]), v[1] + t * (w[1] - v[1])];
  return Math.hypot(p[0] - proj[0], p[1] - proj[1]);
}

/** Min distance (m) from a point to a polyline. */
export function pointToPolylineMeters(pt: Coord, coords: Coord[]): number {
  const refLat = pt[1];
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < coords.length - 1; i++) {
    const d = pointToSegmentMeters(pt, coords[i], coords[i + 1], refLat);
    if (d < min) min = d;
  }
  return min;
}

/** Area-weight-free centroid of a polygon ring (handles closed or unclosed rings). */
export function polygonCentroid(ring: Coord[]): Coord {
  const closed =
    ring.length > 1 &&
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1];
  const n = closed ? ring.length - 1 : ring.length;
  let lng = 0;
  let lat = 0;
  for (let i = 0; i < n; i++) {
    lng += ring[i][0];
    lat += ring[i][1];
  }
  return [lng / n, lat / n];
}

/** Convex hull (Andrew's monotone chain). Returns the subset of input points on
 *  the hull, in order. Hull vertices are original points (value-comparable). */
export function convexHull(points: Coord[]): Coord[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length <= 2) return pts;
  const cross = (o: Coord, a: Coord, b: Coord): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Coord[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
      lower.pop();
    lower.push(p);
  }
  const upper: Coord[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
      upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Nearest point ON a set of polylines to `pt` (used to snap equipment to a street). */
export function nearestPointOnPolylines(pt: Coord, lines: Coord[][]): Coord {
  const refLat = pt[1];
  const p = toXY(pt, refLat);
  let best: { d: number; coord: Coord } | null = null;
  for (const line of lines) {
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i];
      const b = line[i + 1];
      const va = toXY(a, refLat);
      const vb = toXY(b, refLat);
      const l2 = (vb[0] - va[0]) ** 2 + (vb[1] - va[1]) ** 2;
      let t =
        l2 === 0 ? 0 : ((p[0] - va[0]) * (vb[0] - va[0]) + (p[1] - va[1]) * (vb[1] - va[1])) / l2;
      t = Math.max(0, Math.min(1, t));
      const projXY = [va[0] + t * (vb[0] - va[0]), va[1] + t * (vb[1] - va[1])];
      const d = Math.hypot(p[0] - projXY[0], p[1] - projXY[1]);
      if (!best || d < best.d) {
        // interpolate in lng/lat space by the same t (fine for short segments)
        best = { d, coord: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])] };
      }
    }
  }
  return best?.coord ?? pt;
}
