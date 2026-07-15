/**
 * Geometry tools for the `--tools` arm — the function-args executor.
 *
 * The model reads coordinates OUT of its representation and requests
 * computations as JSON lines; this module executes pure planar math on
 * exactly the numbers supplied. INTEGRITY: nothing here can see the scene —
 * a wrong coordinate read produces a wrong (but honestly computed) result.
 * This is the OptiMind executor transplant: screening showed voting/turns
 * fail for lack of an executor; the verdict ceiling shows the pipeline's
 * residual errors are compute-bound (raycasting, segment×polygon, hulls).
 *
 * Units: "m" = planar meters (textmap legend x=/y=); "lnglat" = raw
 * geographic coords, normalized via the same equirectangular local
 * projection the oracle uses (sub-meter at city scale).
 */

export type Pt = [number, number];

interface BaseLine {
  op: string;
  units?: "m" | "lnglat";
  note?: string;
}

const M_PER_DEG_LAT = 110540;

/** Normalize a point list to planar meters. */
function norm(pts: Pt[], units: "m" | "lnglat"): Pt[] {
  if (units === "m") return pts;
  const refLat = pts.reduce((s, p) => s + p[1], 0) / Math.max(1, pts.length);
  const mLng = 111320 * Math.cos((refLat * Math.PI) / 180);
  return pts.map(([lng, lat]) => [lng * mLng, lat * M_PER_DEG_LAT]);
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function pointToSegment(p: Pt, a: Pt, b: Pt): number {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy;
  if (len2 === 0) return dist(p, a);
  let t = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  return dist(p, [a[0] + t * vx, a[1] + t * vy]);
}

function pointToPolyline(p: Pt, line: Pt[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < line.length - 1; i++) {
    best = Math.min(best, pointToSegment(p, line[i], line[i + 1]));
  }
  return line.length === 1 ? dist(p, line[0]) : best;
}

function pointInRing(pt: Pt, ring: Pt[]): boolean {
  const [x, y] = pt;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function ccw(a: Pt, b: Pt, c: Pt): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function segsIntersect(p1: Pt, p2: Pt, p3: Pt, p4: Pt): boolean {
  const d1 = ccw(p3, p4, p1);
  const d2 = ccw(p3, p4, p2);
  const d3 = ccw(p1, p2, p3);
  const d4 = ccw(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0)))
    return true;
  return false;
}

function segmentIntersectsRing(a: Pt, b: Pt, ring: Pt[]): boolean {
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    if (segsIntersect(a, b, ring[j], ring[i])) return true;
  }
  // fully-inside case: both endpoints inside, no edge crossing
  return pointInRing(a, ring) || pointInRing(b, ring);
}

/** Monotone-chain convex hull → indices of hull points in input order. */
function hullIndices(pts: Pt[]): number[] {
  const idx = pts.map((_, i) => i).sort((i, j) => pts[i][0] - pts[j][0] || pts[i][1] - pts[j][1]);
  if (pts.length < 3) return idx;
  const lower: number[] = [];
  for (const i of idx) {
    while (
      lower.length >= 2 &&
      ccw(pts[lower[lower.length - 2]], pts[lower[lower.length - 1]], pts[i]) <= 0
    )
      lower.pop();
    lower.push(i);
  }
  const upper: number[] = [];
  for (const i of [...idx].reverse()) {
    while (
      upper.length >= 2 &&
      ccw(pts[upper[upper.length - 2]], pts[upper[upper.length - 1]], pts[i]) <= 0
    )
      upper.pop();
    upper.push(i);
  }
  return [...new Set([...lower.slice(0, -1), ...upper.slice(0, -1)])];
}

const MAX_LINES = 60;

/** The tool spec shown to the model (kept here so prompt and executor never drift). */
export const GEO_TOOLS_SPEC =
  'Available ops (one JSON object per line, no prose, max 60 lines; every line needs "units": "m" (planar meters, e.g. the legend\'s x=/y=) or "lnglat" (raw geographic coords); optional "note" to label the computation):\n' +
  '{"op":"dist","units":"m","a":[x,y],"b":[x,y]}\n' +
  '{"op":"point_to_line_m","units":"m","p":[x,y],"line":[[x,y],[x,y],...]}\n' +
  '{"op":"point_in_polygon","units":"m","p":[x,y],"ring":[[x,y],...]}\n' +
  '{"op":"segment_intersects_polygon","units":"m","a":[x,y],"b":[x,y],"rings":{"ID1":[[x,y],...],"ID2":[[x,y],...]}}\n' +
  '{"op":"midpoint","units":"m","a":[x,y],"b":[x,y]}\n' +
  '{"op":"convex_hull","units":"m","points":{"ID1":[x,y],"ID2":[x,y],...}}';

function isPt(v: unknown): v is Pt {
  return Array.isArray(v) && v.length >= 2 && Number.isFinite(v[0]) && Number.isFinite(v[1]);
}
function isPtArr(v: unknown): v is Pt[] {
  return Array.isArray(v) && v.length > 0 && v.every(isPt);
}

function execLine(obj: BaseLine & Record<string, unknown>): string {
  const units = obj.units === "lnglat" ? "lnglat" : "m";
  switch (obj.op) {
    case "dist": {
      if (!isPt(obj.a) || !isPt(obj.b)) return "ERROR: dist needs a:[x,y], b:[x,y]";
      const [a, b] = norm([obj.a, obj.b], units);
      return `${dist(a, b).toFixed(1)}m`;
    }
    case "midpoint": {
      if (!isPt(obj.a) || !isPt(obj.b)) return "ERROR: midpoint needs a:[x,y], b:[x,y]";
      // midpoint returns in the INPUT units so the model can reuse it directly
      const a = obj.a;
      const b = obj.b;
      return `[${((a[0] + b[0]) / 2).toFixed(6)}, ${((a[1] + b[1]) / 2).toFixed(6)}] (${units})`;
    }
    case "point_to_line_m": {
      if (!isPt(obj.p) || !isPtArr(obj.line))
        return "ERROR: point_to_line_m needs p:[x,y], line:[[x,y],...]";
      const all = norm([obj.p, ...obj.line], units);
      return `${pointToPolyline(all[0], all.slice(1)).toFixed(1)}m`;
    }
    case "point_in_polygon": {
      if (!isPt(obj.p) || !isPtArr(obj.ring) || obj.ring.length < 3)
        return "ERROR: point_in_polygon needs p:[x,y], ring:[[x,y],...] (>=3 points)";
      const all = norm([obj.p, ...obj.ring], units);
      return String(pointInRing(all[0], all.slice(1)));
    }
    case "segment_intersects_polygon": {
      const rings = obj.rings;
      if (!isPt(obj.a) || !isPt(obj.b) || typeof rings !== "object" || rings === null)
        return "ERROR: needs a:[x,y], b:[x,y], rings:{ID:[[x,y],...]}";
      const hits: string[] = [];
      for (const [id, ring] of Object.entries(rings as Record<string, unknown>)) {
        if (!isPtArr(ring) || ring.length < 3) {
          hits.push(`${id}: ERROR bad ring`);
          continue;
        }
        const all = norm([obj.a, obj.b, ...ring], units);
        if (segmentIntersectsRing(all[0], all[1], all.slice(2))) hits.push(id);
      }
      const clean = hits.filter((h) => !h.includes("ERROR"));
      const errs = hits.filter((h) => h.includes("ERROR"));
      return `intersects: [${clean.join(", ")}]${errs.length ? ` (${errs.join("; ")})` : ""}`;
    }
    case "convex_hull": {
      const points = obj.points;
      if (typeof points !== "object" || points === null)
        return "ERROR: convex_hull needs points:{ID:[x,y],...}";
      const ids = Object.keys(points as Record<string, unknown>);
      const pts = ids.map((k) => (points as Record<string, unknown>)[k]);
      if (!pts.every(isPt) || pts.length < 1) return "ERROR: every point must be [x,y]";
      const hull = hullIndices(norm(pts as Pt[], units));
      return `hull: [${hull.map((i) => ids[i]).join(", ")}]  interior: [${ids
        .filter((_, i) => !hull.includes(i))
        .join(", ")}]`;
    }
    default:
      return `ERROR: unknown op '${String(obj.op)}'`;
  }
}

/** Parse the model's tool-request text (tolerates prose/fences around JSON
 *  lines) and execute every request. Returns the numbered results block, or
 *  null when no valid line was found. */
export function executeGeoToolLines(text: string): string | null {
  const out: string[] = [];
  let n = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^```(json)?|```$/g, "");
    if (!line.startsWith("{")) continue;
    if (n >= MAX_LINES) {
      out.push(`(stopped: more than ${MAX_LINES} tool lines)`);
      break;
    }
    n++;
    let obj: BaseLine & Record<string, unknown>;
    try {
      obj = JSON.parse(line) as BaseLine & Record<string, unknown>;
    } catch {
      out.push(`${n}. ERROR: invalid JSON`);
      continue;
    }
    const note = typeof obj.note === "string" && obj.note ? ` (${obj.note})` : "";
    try {
      out.push(`${n}. ${obj.op}${note} = ${execLine(obj)}`);
    } catch {
      out.push(`${n}. ${obj.op}${note} = ERROR: execution failed`);
    }
  }
  return out.length ? out.join("\n") : null;
}
