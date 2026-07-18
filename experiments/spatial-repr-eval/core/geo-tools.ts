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
  '{"op":"convex_hull","units":"m","points":{"ID1":[x,y],"ID2":[x,y],...}}\n' +
  '{"op":"segments_cross_polygons","units":"m","segments":{"CID1":{"a":[x,y],"b":[x,y],"exclude":["BID"]},...},"rings":{"BID1":[[x,y],...],...}}\n' +
  '{"op":"filter_threshold","cmp":"le","threshold":2,"values":{"CL-A":1.4,"CB-2":7.1,...}}\n' +
  '{"op":"nearest_where","units":"m","target":[x,y],"exclude_field":"street","exclude_value":"Maple Ave","candidates":{"CL-A":{"xy":[x,y],"street":"Oak St"},...}}';

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
    case "segments_cross_polygons": {
      // Batch crossing: every cable segment vs every building ring, minus each
      // segment's own exclusions. Marshals all rings ONCE into a shared planar
      // frame (one refLat) so segments and rings never drift apart under lnglat.
      const segments = obj.segments;
      const rings = obj.rings;
      if (typeof segments !== "object" || segments === null)
        return "ERROR: segments_cross_polygons needs segments:{ID:{a,b,exclude}}";
      if (typeof rings !== "object" || rings === null)
        return "ERROR: segments_cross_polygons needs rings:{ID:[[x,y],...]}";
      const segEntries = Object.entries(segments as Record<string, unknown>);
      const ringEntries = Object.entries(rings as Record<string, unknown>);
      if (segEntries.length === 0) return "ERROR: no segments supplied";
      if (ringEntries.length === 0) return "ERROR: no rings supplied";
      const flat: Pt[] = [];
      const segMeta: { id: string; ai: number; bi: number; exclude: Set<string> }[] = [];
      for (const [id, raw] of segEntries) {
        if (typeof raw !== "object" || raw === null)
          return `ERROR: segment ${id} must be {a:[x,y],b:[x,y],exclude:[...]}`;
        const s = raw as Record<string, unknown>;
        if (!isPt(s.a) || !isPt(s.b)) return `ERROR: segment ${id} needs a:[x,y], b:[x,y]`;
        const exclude = new Set(
          Array.isArray(s.exclude) ? s.exclude.filter((v): v is string => typeof v === "string") : [],
        );
        const ai = flat.length;
        flat.push(s.a);
        const bi = flat.length;
        flat.push(s.b);
        segMeta.push({ id, ai, bi, exclude });
      }
      const ringMeta: { id: string; start: number; len: number }[] = [];
      for (const [id, ring] of ringEntries) {
        if (!isPtArr(ring) || ring.length < 3) return `ERROR: ring ${id} needs >=3 valid points`;
        ringMeta.push({ id, start: flat.length, len: ring.length });
        for (const pt of ring) flat.push(pt);
      }
      const normed = norm(flat, units);
      const out: string[] = [];
      for (const sm of segMeta) {
        const a = normed[sm.ai];
        const b = normed[sm.bi];
        const hits: string[] = [];
        for (const rm of ringMeta) {
          if (sm.exclude.has(rm.id)) continue;
          if (segmentIntersectsRing(a, b, normed.slice(rm.start, rm.start + rm.len)))
            hits.push(rm.id);
        }
        out.push(`${sm.id} -> crosses: [${hits.join(", ")}]`);
      }
      return out.join(" | ");
    }
    case "filter_threshold": {
      // Enumerate + threshold over a value column. Deterministic pass/fail split;
      // never sees the scene — only the model-supplied {id: number} map.
      const cmp = obj.cmp;
      const threshold = obj.threshold;
      const values = obj.values;
      if (cmp !== "le" && cmp !== "lt" && cmp !== "ge" && cmp !== "gt")
        return "ERROR: filter_threshold needs cmp in {le,lt,ge,gt}";
      if (typeof threshold !== "number" || !Number.isFinite(threshold))
        return "ERROR: filter_threshold needs a numeric threshold";
      if (typeof values !== "object" || values === null)
        return "ERROR: filter_threshold needs values:{id:number}";
      const pass: string[] = [];
      const fail: string[] = [];
      for (const [id, v] of Object.entries(values as Record<string, unknown>)) {
        if (typeof v !== "number" || !Number.isFinite(v))
          return `ERROR: value for ${id} must be a finite number`;
        const ok =
          cmp === "le" ? v <= threshold : cmp === "lt" ? v < threshold : cmp === "ge" ? v >= threshold : v > threshold;
        (ok ? pass : fail).push(id);
      }
      return `{"pass":${JSON.stringify(pass)},"fail":${JSON.stringify(fail)},"n_in":${pass.length + fail.length},"n_pass":${pass.length}}`;
    }
    case "nearest_where": {
      // Filter by a field value, then argmin distance to a target. The excluded
      // value is a stated criterion, never the answer — the op returns the argmin
      // over surviving candidates, computed on model-supplied coordinates only.
      const target = obj.target;
      const field = obj.exclude_field;
      const exValueRaw = obj.exclude_value;
      const candidates = obj.candidates;
      if (!isPt(target)) return "ERROR: nearest_where needs target:[x,y]";
      if (typeof field !== "string") return "ERROR: nearest_where needs exclude_field (string)";
      if (typeof candidates !== "object" || candidates === null)
        return "ERROR: nearest_where needs candidates:{id:{xy:[x,y],<field>:value}}";
      const exValue = typeof exValueRaw === "string" ? exValueRaw : String(exValueRaw);
      const entries = Object.entries(candidates as Record<string, unknown>);
      if (entries.length === 0) return "ERROR: no candidates supplied";
      const flat: Pt[] = [target];
      const meta: { id: string; idx: number; field: string }[] = [];
      const excluded: string[] = [];
      for (const [id, raw] of entries) {
        if (typeof raw !== "object" || raw === null)
          return `ERROR: candidate ${id} must be {xy:[x,y],${field}:value}`;
        const c = raw as Record<string, unknown>;
        if (!isPt(c.xy)) return `ERROR: candidate ${id} needs xy:[x,y]`;
        const fv = c[field];
        const fieldVal = typeof fv === "string" ? fv : String(fv);
        if (fieldVal === exValue) {
          excluded.push(id);
          continue;
        }
        meta.push({ id, idx: flat.length, field: fieldVal });
        flat.push(c.xy);
      }
      const normed = norm(flat, units);
      const t = normed[0];
      const ranked = meta
        .map((m) => ({ id: m.id, field: m.field, d: dist(t, normed[m.idx]) }))
        .sort((x, y) => x.d - y.d);
      const nearest = ranked.length ? ranked[0].id : "none";
      const rankedStr = ranked.map((r) => `${r.id}(${r.field})=${r.d.toFixed(1)}`).join(", ");
      return `nearest:${nearest} | ranked: ${rankedStr} | excluded:[${excluded.join(", ")}]`;
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
