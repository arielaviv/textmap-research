/**
 * `textmap` — an LLM-optimized text representation of a Scene.
 *
 * Built fresh (NOT the production generateZoneAsciiGrid) for one purpose:
 * maximal machine + human legibility. Two parts:
 *
 *   1. A single north-up ASCII grid, single-byte chars only (one code-point per
 *      cell → exact column counting), markers placed at each entity. Gestalt.
 *   2. A LEGEND keyed by the REAL scene ids (B-0, CL-3-2, …) with each entity's
 *      exact (col,row), meters-from-SW, address, and relationships. Precision —
 *      so the model never has to count columns for an accurate answer, and the
 *      grid/legend/answer namespaces all agree.
 *
 * `toTextMapV2` is the second-generation grid targeting two known LLM failure
 * modes of v1 (kept frozen as the ablation baseline — same legend, new grid):
 *
 *   - OCCLUSION: v1 paints one canvas, so an equipment glyph overwrites the '#'
 *    underneath and a cable is not drawn through buildings at all — the render
 *    destroys exactly the evidence containment/crossing questions need. v2 uses
 *    two ALIGNED LAYERS (geography / network) like any real GIS: the network
 *    layer draws positions and full cable paths unoccluded, and cross-layer
 *    lookup at the same (col,row) recovers what sits under what.
 *   - TOKENIZATION: BPE merges runs ("....####....") into blobs, destroying
 *    column identity before the model reads it. v2 space-separates cells so
 *    each cell keeps its own token and rulers align 1:1 with content.
 *
 * Pure + dependency-light (only ./geo) so it unit-tests without pulling the
 * heavy zone-text-twin module that representations.ts imports.
 */

import { haversineMeters, pointInPolygon, pointToPolylineMeters } from "./geo";
import type { Coord, Scene, SceneBounds, SceneBuilding } from "./scene";

const GRID_W = 48;
const MAX_H = 28;
const MIN_H = 6;
/** Building markers: digits then uppercase (≤36 buildings per scene here). */
const BUILDING_LABELS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** Non-CO equipment markers: lowercase (distinct from building labels). */
const EQUIP_LETTERS = "abcdefghijklmnopqrstuvwxyz";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
function padRight(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}
function addrStr(b: SceneBuilding): string {
  return b.address ? `${b.address.number} ${b.address.street}`.trim() : "";
}

/** Bresenham raster between two grid cells, calling `plot` on each. */
function bresenham(
  c0: number,
  r0: number,
  c1: number,
  r1: number,
  plot: (col: number, row: number) => void,
): void {
  const dc = Math.abs(c1 - c0);
  const dr = Math.abs(r1 - r0);
  const sc = c0 < c1 ? 1 : -1;
  const sr = r0 < r1 ? 1 : -1;
  let err = dc - dr;
  let cx = c0;
  let cy = r0;
  const maxSteps = dc + dr + 2;
  for (let s = 0; s <= maxSteps; s++) {
    plot(cx, cy);
    if (cx === c1 && cy === r1) break;
    const e2 = 2 * err;
    if (e2 > -dr) {
      err -= dr;
      cx += sc;
    }
    if (e2 < dc) {
      err += dc;
      cy += sr;
    }
  }
}

/**
 * Liang–Barsky clip of segment a→b to the bounds rectangle (lng/lat space).
 * Returns the in-frame sub-segment, or null if the segment never enters the
 * frame. Used so out-of-frame streets don't get clamped onto the grid edges.
 */
function clipSegment(a: Coord, b: Coord, bnd: SceneBounds): [Coord, Coord] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const p = [-dx, dx, -dy, dy];
  const q = [a[0] - bnd.minLng, bnd.maxLng - a[0], a[1] - bnd.minLat, bnd.maxLat - a[1]];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return null; // parallel to this edge and outside it
    } else {
      const r = q[i] / p[i];
      if (p[i] < 0) {
        if (r > t1) return null;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return null;
        if (r < t1) t1 = r;
      }
    }
  }
  return [
    [a[0] + t0 * dx, a[1] + t0 * dy],
    [a[0] + t1 * dx, a[1] + t1 * dy],
  ];
}

export function toTextMap(scene: Scene, opts: { network?: boolean } = {}): string {
  // network=false → a "base" canvas: geography only (buildings + streets), no
  // equipment/cables — what the area looks like before any design is placed.
  const showNetwork = opts.network !== false;
  const { minLng, minLat, maxLng, maxLat } = scene.bounds;
  const widthM = Math.max(1, haversineMeters([minLng, minLat], [maxLng, minLat]));
  const heightM = Math.max(1, haversineMeters([minLng, minLat], [minLng, maxLat]));

  const gw = GRID_W;
  const gh = Math.max(MIN_H, Math.min(MAX_H, Math.round((GRID_W * heightM) / widthM)));

  const cellW = (maxLng - minLng) / gw || 1;
  const cellH = (maxLat - minLat) / gh || 1;
  const mpcX = widthM / gw;
  const mpcY = heightM / gh;

  // Fractional grid coords: col 0 = west, row 0 = north (max lat).
  const toFrac = (c: Coord): [number, number] => [
    (c[0] - minLng) / cellW,
    gh - (c[1] - minLat) / cellH,
  ];
  const toCell = (c: Coord): [number, number] => {
    const [fx, fy] = toFrac(c);
    return [
      Math.max(0, Math.min(gw - 1, Math.floor(fx))),
      Math.max(0, Math.min(gh - 1, Math.floor(fy))),
    ];
  };
  // Exact meters of an entity from the SW corner (independent of grid rounding).
  const xM = (c: Coord): number => Math.round(haversineMeters([minLng, c[1]], [c[0], c[1]]));
  const yM = (c: Coord): number => Math.round(haversineMeters([c[0], minLat], [c[0], c[1]]));

  const grid: string[][] = Array.from({ length: gh }, () => Array(gw).fill("."));
  const set = (col: number, row: number, ch: string, onlyEmpty = false): void => {
    if (col < 0 || col >= gw || row < 0 || row >= gh) return;
    if (onlyEmpty && grid[row][col] !== ".") return;
    grid[row][col] = ch;
  };

  // ── Streets (= horizontal, | vertical), clipped to the frame ────────────
  for (const s of scene.streets) {
    for (let i = 0; i < s.coordinates.length - 1; i++) {
      const clip = clipSegment(s.coordinates[i], s.coordinates[i + 1], scene.bounds);
      if (!clip) continue; // segment never enters the frame — don't smear it on an edge
      const [a, b] = clip;
      const sym = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]) ? "=" : "|";
      const [c0, r0] = toCell(a);
      const [c1, r1] = toCell(b);
      bresenham(c0, r0, c1, r1, (col, row) => set(col, row, sym, true));
    }
  }

  // ── Named streets: id token on the grid + STREETS legend + closure on= ───
  interface NamedStreet {
    id: string;
    name: string;
    polylines: Coord[][];
    orientation: "E-W" | "N-S";
  }
  const byName = new Map<string, Coord[][]>();
  for (const s of scene.streets) {
    const nm = (s.name ?? "").trim();
    // Skip the real-scene "street N" placeholder for unnamed OSM ways; keep real
    // names (Hebrew/English) and synthetic "H Street 0".
    if (!nm || /^street \d+$/i.test(nm) || s.coordinates.length < 2) continue;
    const arr = byName.get(nm) ?? [];
    arr.push(s.coordinates);
    byName.set(nm, arr);
  }
  const namedStreets: NamedStreet[] = [];
  let streetIdx = 0;
  for (const [name, polylines] of byName) {
    const pts = polylines.flat();
    let mnL = Number.POSITIVE_INFINITY;
    let mxL = Number.NEGATIVE_INFINITY;
    let mnA = Number.POSITIVE_INFINITY;
    let mxA = Number.NEGATIVE_INFINITY;
    for (const [lng, lat] of pts) {
      if (lng < mnL) mnL = lng;
      if (lng > mxL) mxL = lng;
      if (lat < mnA) mnA = lat;
      if (lat > mxA) mxA = lat;
    }
    const midA = (mnA + mxA) / 2;
    const wM = haversineMeters([mnL, midA], [mxL, midA]);
    const hM = haversineMeters([mnL, mnA], [mnL, mxA]);
    namedStreets.push({ id: `S${streetIdx++}`, name, polylines, orientation: wM >= hM ? "E-W" : "N-S" });
  }
  // Stamp each street's id at a representative cell, only over street/empty cells.
  for (const ns of namedStreets) {
    const longest = ns.polylines.reduce((a, b) => (b.length > a.length ? b : a), ns.polylines[0]);
    const [c0, r] = toCell(longest[Math.floor(longest.length / 2)]);
    const fits = [...ns.id].every((_, i) => {
      const c = c0 + i;
      return c < gw && (grid[r][c] === "=" || grid[r][c] === "|" || grid[r][c] === ".");
    });
    if (fits) for (let i = 0; i < ns.id.length; i++) grid[r][c0 + i] = ns.id[i];
  }
  const nearestNamedStreet = (pos: Coord): NamedStreet | null => {
    let best: { d: number; s: NamedStreet } | null = null;
    for (const s of namedStreets) {
      for (const pl of s.polylines) {
        const d = pointToPolylineMeters(pos, pl);
        if (!best || d < best.d) best = { d, s };
      }
    }
    return best?.s ?? null;
  };

  // ── Building footprints (#) + index label at centroid ───────────────────
  const buildingMarker = new Map<string, string>();
  scene.buildings.forEach((b, bi) => {
    const marker = BUILDING_LABELS[bi] ?? "?";
    buildingMarker.set(b.id, marker);
    const ring = b.footprint.map(toFrac) as Coord[];
    const xs = ring.map((p) => p[0]);
    const ys = ring.map((p) => p[1]);
    const minX = Math.max(0, Math.floor(Math.min(...xs)));
    const maxX = Math.min(gw - 1, Math.ceil(Math.max(...xs)));
    const minY = Math.max(0, Math.floor(Math.min(...ys)));
    const maxY = Math.min(gh - 1, Math.ceil(Math.max(...ys)));
    let filled = 0;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (pointInPolygon([x + 0.5, y + 0.5], ring)) {
          grid[y][x] = "#";
          filled++;
        }
      }
    }
    const [cc, cr] = toCell(b.centroid);
    if (filled === 0) grid[cr][cc] = "#";
    grid[cr][cc] = marker; // label wins over its own fill
  });

  // ── Building-edge margin (:) — a 1-cell buffer of open space hugging buildings.
  //    This is INFERRED from footprints (cells adjacent to a building), NOT real
  //    sidewalk data — we have none. It is a rendering aid for routing, not a fact;
  //    the GLYPHS legend says so to avoid the agent asserting surveyed sidewalks.
  const buildingCells: [number, number][] = [];
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) if (grid[y][x] === "#") buildingCells.push([x, y]);
  }
  for (const [bx, by] of buildingCells) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = bx + dx;
        const ny = by + dy;
        if (nx >= 0 && nx < gw && ny >= 0 && ny < gh && grid[ny][nx] === ".") grid[ny][nx] = ":";
      }
    }
  }

  // ── Cables (- drawn over open '.' or building-edge margin ':' cells) ─────
  if (showNetwork) {
    for (const cab of scene.cables) {
      for (let i = 0; i < cab.path.length - 1; i++) {
        const clip = clipSegment(cab.path[i], cab.path[i + 1], scene.bounds);
        if (!clip) continue;
        const [c0, r0] = toCell(clip[0]);
        const [c1, r1] = toCell(clip[1]);
        bresenham(c0, r0, c1, r1, (col, row) => {
          if (grid[row][col] === "." || grid[row][col] === ":") grid[row][col] = "-";
        });
      }
    }
  }

  // ── Equipment markers (CO = *, cabinet = @, closures = a,b,c…) ──────────
  const equipMarker = new Map<string, string>();
  if (showNetwork) {
    let li = 0;
    for (const e of scene.equipment) {
      const marker =
        e.kind === "co" ? "*" : e.kind === "cabinet" ? "@" : (EQUIP_LETTERS[li++] ?? "?");
      equipMarker.set(e.id, marker);
      const [col, row] = toCell(e.position);
      set(col, row, marker);
    }
  }

  // ── Format ──────────────────────────────────────────────────────────────
  const buildingById = new Map(scene.buildings.map((b) => [b.id, b]));
  const lines: string[] = [];
  lines.push(
    `${showNetwork ? "TEXT MAP" : "BASE MAP (geography only — no equipment/cables; the empty canvas)"} — ` +
      `single grid, north-up. 1 cell ≈ ${((mpcX + mpcY) / 2).toFixed(1)}m. ` +
      `col 0..${gw - 1} = W→E, row 0..${gh - 1} = N→S (row 0 = north).`,
  );
  // Exact cell→coordinate conversion so the agent can place/route precisely
  // (no scale guessing). Inverse of toCell, at the cell centre.
  lines.push(
    `GRID REF — cell(col,row) centre = [lng, lat]:  ` +
      `lng = ${minLng.toFixed(7)} + (col+0.5)*${cellW.toExponential(4)};  ` +
      `lat = ${maxLat.toFixed(7)} - (row+0.5)*${cellH.toExponential(4)}`,
  );
  lines.push(
    showNetwork
      ? "GLYPHS:  . open   : open margin beside a building (INFERRED from footprints — NOT a surveyed sidewalk)   # building   =|street   - cable   * CO   @ cabinet   a-z closures   0-9/A-Z buildings"
      : "GLYPHS:  . open   : open margin beside a building (INFERRED — NOT a surveyed sidewalk)   # building   =|street   0-9/A-Z buildings",
  );
  const tens = Array.from({ length: gw }, (_, c) => String(Math.floor(c / 10) % 10)).join("");
  const ones = Array.from({ length: gw }, (_, c) => String(c % 10)).join("");
  lines.push(`    ${tens}`);
  lines.push(`    ${ones}`);
  lines.push(`   +${"-".repeat(gw)}+`);
  for (let r = 0; r < gh; r++) lines.push(`${pad2(r)} |${grid[r].join("")}|`);
  lines.push(`   +${"-".repeat(gw)}+`);

  lines.push("");
  lines.push("LEGEND  (id · marker · cell(col,row) · meters(x,y from SW) · detail)");
  if (showNetwork) {
    for (const e of scene.equipment) {
      const [col, row] = toCell(e.position);
      const marker = equipMarker.get(e.id) ?? "?";
      let detail: string;
      if (e.kind === "co") {
        detail = "source";
      } else {
        const serves = e.serves.length ? ` serves=${e.serves.join(",")}` : "";
        const near = e.serves.map((id) => buildingById.get(id)).find((b) => b?.address);
        const nearStr = near ? ` near "${addrStr(near)}"` : "";
        const ns = nearestNamedStreet(e.position);
        const onStr = ns ? ` on=${ns.id} "${ns.name}"` : "";
        detail = `${e.kind}${serves}${onStr}${nearStr}`;
      }
      lines.push(
        `  ${padRight(e.id, 8)} ${marker}  (${col},${row})  x=${xM(e.position)} y=${yM(e.position)}  ${detail}`,
      );
    }
  }
  scene.buildings.forEach((b, bi) => {
    const [col, row] = toCell(b.centroid);
    const marker = BUILDING_LABELS[bi] ?? "?";
    const addr = b.address ? ` addr "${addrStr(b)}"` : "";
    lines.push(
      `  ${padRight(b.id, 8)} ${marker}  (${col},${row})  x=${xM(b.centroid)} y=${yM(b.centroid)}  ${b.type} floors=${b.floors}${addr}`,
    );
  });

  if (namedStreets.length) {
    lines.push("");
    lines.push("STREETS  (id · orientation · name)");
    for (const ns of namedStreets) {
      lines.push(`  ${padRight(ns.id, 4)} ${padRight(ns.orientation, 4)} ${ns.name}`);
    }
  }

  if (showNetwork && scene.cables.length) {
    lines.push("");
    lines.push("CABLES");
    for (const c of scene.cables) {
      const [a0, ar0] = toCell(c.path[0]);
      const [a1, ar1] = toCell(c.path[c.path.length - 1]);
      lines.push(
        `  ${padRight(c.id, 14)} ${padRight(c.kind, 13)} ${c.sourceId} -> ${c.targetId}  (${a0},${ar0})->(${a1},${ar1})`,
      );
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// textmap v2 — aligned layers, one token per cell, directional cables
// ---------------------------------------------------------------------------

/** Directional glyph for a cable segment in cell space (row grows southward). */
function cableGlyph(dc: number, dr: number): string {
  const adc = Math.abs(dc);
  const adr = Math.abs(dr);
  if (adc >= 2 * adr) return "-";
  if (adr >= 2 * adc) return "|";
  return dc * dr > 0 ? "\\" : "/";
}

export function toTextMapV2(
  scene: Scene,
  opts: { protocol?: boolean; zoom?: number; extents?: boolean } = {},
): string {
  // protocol=false strips the READING-PROTOCOL lines (cross-reference rule,
  // worked example, geometry-vs-topology, thresholds) while keeping every DATA
  // element — grids, glyph keys, GRID REF, legend measurements. The ablation
  // that isolates "representation = format + protocol".
  // zoom>1 (v2.6, labeled artifact revision) scales grid resolution — smaller
  // cells reduce raster over-approximation (crossing/touches) at a token cost.
  // extents (v2.7, labeled artifact revision) adds each building's exact
  // footprint bounding box in meters to its legend row — a world fact,
  // question-agnostic, feeding the geometry-tools executor exact inputs (the
  // tools probe showed models invent ~4m rings when the legend has none).
  const protocol = opts.protocol !== false;
  const zoom = Math.max(1, Math.min(opts.zoom ?? 1, 2));
  const extents = opts.extents === true;
  const { minLng, minLat, maxLng, maxLat } = scene.bounds;
  const widthM = Math.max(1, haversineMeters([minLng, minLat], [maxLng, minLat]));
  const heightM = Math.max(1, haversineMeters([minLng, minLat], [minLng, maxLat]));

  const gw = Math.round(GRID_W * zoom);
  const gh = Math.max(
    MIN_H,
    Math.min(Math.round(MAX_H * zoom), Math.round((gw * heightM) / widthM)),
  );
  const cellW = (maxLng - minLng) / gw || 1;
  const cellH = (maxLat - minLat) / gh || 1;
  const mpcX = widthM / gw;
  const mpcY = heightM / gh;

  const toFrac = (c: Coord): [number, number] => [
    (c[0] - minLng) / cellW,
    gh - (c[1] - minLat) / cellH,
  ];
  const toCell = (c: Coord): [number, number] => {
    const [fx, fy] = toFrac(c);
    return [
      Math.max(0, Math.min(gw - 1, Math.floor(fx))),
      Math.max(0, Math.min(gh - 1, Math.floor(fy))),
    ];
  };
  const xM = (c: Coord): number => Math.round(haversineMeters([minLng, c[1]], [c[0], c[1]]));
  const yM = (c: Coord): number => Math.round(haversineMeters([c[0], minLat], [c[0], c[1]]));

  // Two ALIGNED grids sharing one frame. base = geography; net = network drawn
  // on an empty field WITHOUT occlusion — the whole point of v2: nothing ever
  // overwrites the evidence (P1 lossless-at-query-time).
  const base: string[][] = Array.from({ length: gh }, () => Array(gw).fill("."));
  const net: string[][] = Array.from({ length: gh }, () => Array(gw).fill("."));
  // Semantic surface per cell (ignores cosmetic labels/stamps) + which building
  // owns each '#' — feeds the legend's materialized `under=` join (v2.1).
  const surface: string[][] = Array.from({ length: gh }, () => Array(gw).fill("."));
  const owner: (string | null)[][] = Array.from({ length: gh }, () => Array(gw).fill(null));
  const setBase = (col: number, row: number, ch: string, onlyEmpty = false): void => {
    if (col < 0 || col >= gw || row < 0 || row >= gh) return;
    if (onlyEmpty && base[row][col] !== ".") return;
    base[row][col] = ch;
  };
  const setSurface = (col: number, row: number, ch: string, onlyEmpty = false): void => {
    if (col < 0 || col >= gw || row < 0 || row >= gh) return;
    if (onlyEmpty && surface[row][col] !== ".") return;
    surface[row][col] = ch;
  };
  const setNet = (col: number, row: number, ch: string): void => {
    if (col < 0 || col >= gw || row < 0 || row >= gh) return;
    net[row][col] = ch;
  };

  // ── LAYER 1: streets ─────────────────────────────────────────────────────
  for (const s of scene.streets) {
    for (let i = 0; i < s.coordinates.length - 1; i++) {
      const clip = clipSegment(s.coordinates[i], s.coordinates[i + 1], scene.bounds);
      if (!clip) continue;
      const [a, b] = clip;
      const sym = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]) ? "=" : "|";
      const [c0, r0] = toCell(a);
      const [c1, r1] = toCell(b);
      bresenham(c0, r0, c1, r1, (col, row) => {
        setBase(col, row, sym, true);
        setSurface(col, row, sym, true);
      });
    }
  }

  // Named streets (same grouping + placeholder rule as v1).
  interface NamedStreet {
    id: string;
    name: string;
    polylines: Coord[][];
    orientation: "E-W" | "N-S";
  }
  const byName = new Map<string, Coord[][]>();
  for (const s of scene.streets) {
    const nm = (s.name ?? "").trim();
    if (!nm || /^street \d+$/i.test(nm) || s.coordinates.length < 2) continue;
    const arr = byName.get(nm) ?? [];
    arr.push(s.coordinates);
    byName.set(nm, arr);
  }
  const namedStreets: NamedStreet[] = [];
  let streetIdx = 0;
  for (const [name, polylines] of byName) {
    const pts = polylines.flat();
    let mnL = Number.POSITIVE_INFINITY;
    let mxL = Number.NEGATIVE_INFINITY;
    let mnA = Number.POSITIVE_INFINITY;
    let mxA = Number.NEGATIVE_INFINITY;
    for (const [lng, lat] of pts) {
      if (lng < mnL) mnL = lng;
      if (lng > mxL) mxL = lng;
      if (lat < mnA) mnA = lat;
      if (lat > mxA) mxA = lat;
    }
    const midA = (mnA + mxA) / 2;
    const wM = haversineMeters([mnL, midA], [mxL, midA]);
    const hM = haversineMeters([mnL, mnA], [mnL, mxA]);
    namedStreets.push({
      id: `S${streetIdx++}`,
      name,
      polylines,
      orientation: wM >= hM ? "E-W" : "N-S",
    });
  }
  for (const ns of namedStreets) {
    const longest = ns.polylines.reduce((a, b) => (b.length > a.length ? b : a), ns.polylines[0]);
    const [c0, r] = toCell(longest[Math.floor(longest.length / 2)]);
    const fits = [...ns.id].every((_, i) => {
      const c = c0 + i;
      return c < gw && (base[r][c] === "=" || base[r][c] === "|" || base[r][c] === ".");
    });
    if (fits) for (let i = 0; i < ns.id.length; i++) base[r][c0 + i] = ns.id[i];
  }
  const nearestNamedStreet = (pos: Coord): NamedStreet | null => {
    let best: { d: number; s: NamedStreet } | null = null;
    for (const s of namedStreets) {
      for (const pl of s.polylines) {
        const d = pointToPolylineMeters(pos, pl);
        if (!best || d < best.d) best = { d, s };
      }
    }
    return best?.s ?? null;
  };

  // ── LAYER 1: building footprints + labels + margins ──────────────────────
  scene.buildings.forEach((b, bi) => {
    const marker = BUILDING_LABELS[bi] ?? "?";
    const ring = b.footprint.map(toFrac) as Coord[];
    const xs = ring.map((p) => p[0]);
    const ys = ring.map((p) => p[1]);
    const minX = Math.max(0, Math.floor(Math.min(...xs)));
    const maxX = Math.min(gw - 1, Math.ceil(Math.max(...xs)));
    const minY = Math.max(0, Math.floor(Math.min(...ys)));
    const maxY = Math.min(gh - 1, Math.ceil(Math.max(...ys)));
    let filled = 0;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (pointInPolygon([x + 0.5, y + 0.5], ring)) {
          base[y][x] = "#";
          surface[y][x] = "#";
          owner[y][x] = b.id;
          filled++;
        }
      }
    }
    const [cc, cr] = toCell(b.centroid);
    if (filled === 0) {
      base[cr][cc] = "#";
      surface[cr][cc] = "#";
      owner[cr][cc] = b.id;
    }
    base[cr][cc] = marker;
  });
  const bCells: [number, number][] = [];
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) if (base[y][x] === "#") bCells.push([x, y]);
  }
  for (const [bx, by] of bCells) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = bx + dx;
        const ny = by + dy;
        if (nx >= 0 && nx < gw && ny >= 0 && ny < gh && base[ny][nx] === ".") {
          base[ny][nx] = ":";
          setSurface(nx, ny, ":", true);
        }
      }
    }
  }

  // ── LAYER 2: cables (full path, unoccluded, directional glyphs) ──────────
  for (const cab of scene.cables) {
    for (let i = 0; i < cab.path.length - 1; i++) {
      const clip = clipSegment(cab.path[i], cab.path[i + 1], scene.bounds);
      if (!clip) continue;
      const [c0, r0] = toCell(clip[0]);
      const [c1, r1] = toCell(clip[1]);
      const g = cableGlyph(c1 - c0, r1 - r0);
      bresenham(c0, r0, c1, r1, (col, row) => setNet(col, row, g));
    }
  }

  // ── LAYER 2: equipment (drawn last — never occluded by anything) ─────────
  const equipMarker = new Map<string, string>();
  let li = 0;
  for (const e of scene.equipment) {
    const marker = e.kind === "co" ? "*" : e.kind === "cabinet" ? "@" : (EQUIP_LETTERS[li++] ?? "?");
    equipMarker.set(e.id, marker);
    const [col, row] = toCell(e.position);
    setNet(col, row, marker);
  }

  // ── Format: one token per cell (space-separated), self-locating rows ─────
  const spacedGrid = (grid: string[][]): string[] => {
    const tens = Array.from({ length: gw }, (_, c) => String(Math.floor(c / 10) % 10)).join(" ");
    const ones = Array.from({ length: gw }, (_, c) => String(c % 10)).join(" ");
    const out: string[] = [`     ${tens}`, `     ${ones}`];
    for (let r = 0; r < gh; r++) out.push(`${pad2(r)} | ${grid[r].join(" ")} | ${pad2(r)}`);
    return out;
  };

  const buildingById = new Map(scene.buildings.map((b) => [b.id, b]));
  const lines: string[] = [];
  lines.push(
    `TEXT MAP v2 — two ALIGNED layers, one grid frame, north-up. 1 cell ≈ ${((mpcX + mpcY) / 2).toFixed(1)}m. ` +
      `col 0..${gw - 1} = W→E, row 0..${gh - 1} = N→S (row 0 = north). Cells are space-separated (one symbol = one cell).`,
  );
  lines.push(
    `GRID REF — cell(col,row) centre = [lng, lat]:  ` +
      `lng = ${minLng.toFixed(7)} + (col+0.5)*${cellW.toExponential(4)};  ` +
      `lat = ${maxLat.toFixed(7)} - (row+0.5)*${cellH.toExponential(4)}`,
  );
  if (protocol)
    lines.push(
      "CROSS-REFERENCE: the layers share coordinates. Look up the SAME (col,row) in both layers: " +
        "an equipment marker over '#' in LAYER 1 sits INSIDE that building; a cable glyph over '#' " +
        "crosses that building — UNLESS that building is the cable's own source or target " +
        "(a drop legitimately ENDS inside the building it serves; check CABLES source -> target).",
    );
  if (protocol)
    lines.push(
      "HOW TO READ (hypothetical example, NOT from this scene): if LAYER 2 shows marker 'q' at " +
        "(3,1) and LAYER 1 at (3,1) shows '#', that equipment sits INSIDE that building; '=' or '|' " +
        "there means it sits on a street; ':' or '.' means open ground. The LEGEND's inside= field " +
        "precomputes building containment exactly for every equipment item.",
    );
  if (protocol)
    lines.push(
      "GEOMETRY vs TOPOLOGY: the grids show WHERE things are (geometry). WHO connects to whom " +
        "(topology) is in the LEGEND — each closure's serves= list and the CABLES section's " +
        "source -> target. For connectivity/path questions, read the LEGEND; do not trace glyphs.",
    );
    lines.push("");
  lines.push(
    "LAYER 1/2 — GEOGRAPHY   (. open   : open margin beside a building (INFERRED from footprints — NOT a surveyed sidewalk)   # building   = | street   0-9/A-Z building labels)",
  );
  lines.push(...spacedGrid(base));
  lines.push("");
  lines.push(
    "LAYER 2/2 — NETWORK   (* CO   @ cabinet   a-z closures   - | / \\ cable path; drawn UNOCCLUDED — the full position/path even where it overlaps geography)",
  );
  lines.push(...spacedGrid(net));

  // ── Legend: identical content to v1 — the v1 vs v2 comparison isolates ───
  // pure grid design.
  lines.push("");
  lines.push(
    "LEGEND  (id · marker · cell(col,row) · meters(x,y from SW) · detail; " +
      "inside= names the building whose footprint contains the entity's EXACT position " +
      "(none = outside every footprint); d_street= is the exact distance in meters to the " +
      "nearest street centerline; buildings carry d_closure= — exact distance to the nearest closure" +
      (extents
        ? "; ext= is the building's exact footprint bounding box in meters, same frame as x=/y= " +
          "— for geometric computations use ext=, never grid cells"
        : "") +
      ")",
  );
  for (const e of scene.equipment) {
    const [col, row] = toCell(e.position);
    const marker = equipMarker.get(e.id) ?? "?";
    // Exact geometry only. inside= does ONE job — building containment — and
    // street-ness is conveyed ONLY by the d_street number: categorical surface
    // labels (":' beside building") kept out-competing the measurement in the
    // model's reading (probe: 3/8 on-street with labels present).
    let dStreet = Number.POSITIVE_INFINITY;
    for (const st of scene.streets) {
      const d = pointToPolylineMeters(e.position, st.coordinates);
      if (d < dStreet) dStreet = d;
    }
    const inBuilding = scene.buildings.find((b) => pointInPolygon(e.position, b.footprint));
    const under = inBuilding ? inBuilding.id : "none";
    const dStreetStr = Number.isFinite(dStreet) ? ` d_street=${dStreet.toFixed(1)}m` : "";
    let detail: string;
    if (e.kind === "co") {
      detail = "source";
    } else {
      const serves = e.serves.length ? ` serves=${e.serves.join(",")}` : "";
      const near = e.serves.map((id) => buildingById.get(id)).find((b) => b?.address);
      const nearStr = near ? ` near "${addrStr(near)}"` : "";
      const ns = nearestNamedStreet(e.position);
      const onStr = ns ? ` on=${ns.id} "${ns.name}"` : "";
      detail = `${e.kind}${serves}${onStr}${nearStr}`;
    }
    lines.push(
      `  ${padRight(e.id, 8)} ${marker}  (${col},${row})  x=${xM(e.position)} y=${yM(e.position)}  ${detail} inside=${under}${dStreetStr}`,
    );
  }
  scene.buildings.forEach((b, bi) => {
    const [col, row] = toCell(b.centroid);
    const marker = BUILDING_LABELS[bi] ?? "?";
    const addr = b.address ? ` addr "${addrStr(b)}"` : "";
    // d_closure= completes the measurement symmetry: every entity carries its
    // exact distances to what matters (streets for equipment, serving
    // infrastructure for buildings). Distance only — never the id.
    let dClosure = Number.POSITIVE_INFINITY;
    for (const e of scene.equipment) {
      if (e.kind !== "closure") continue;
      const d = haversineMeters(b.centroid, e.position);
      if (d < dClosure) dClosure = d;
    }
    const dc = Number.isFinite(dClosure) ? ` d_closure=${dClosure.toFixed(1)}m` : "";
    // v2.7: exact footprint bounding box in the same meter frame as x=/y= —
    // the geometry a tool call needs, without full-ring token cost.
    let ext = "";
    if (extents && b.footprint.length >= 3) {
      const xs = b.footprint.map(xM);
      const ys = b.footprint.map(yM);
      ext = ` ext=x${Math.min(...xs)}..${Math.max(...xs)} y${Math.min(...ys)}..${Math.max(...ys)}`;
    }
    lines.push(
      `  ${padRight(b.id, 8)} ${marker}  (${col},${row})  x=${xM(b.centroid)} y=${yM(b.centroid)}  ${b.type} floors=${b.floors}${addr}${dc}${ext}`,
    );
  });

  if (namedStreets.length) {
    lines.push("");
    lines.push("STREETS  (id · orientation · name)");
    for (const ns of namedStreets) {
      lines.push(`  ${padRight(ns.id, 4)} ${padRight(ns.orientation, 4)} ${ns.name}`);
    }
  }

  if (scene.cables.length) {
    lines.push("");
    lines.push("CABLES");
    for (const c of scene.cables) {
      const [a0, ar0] = toCell(c.path[0]);
      const [a1, ar1] = toCell(c.path[c.path.length - 1]);
      lines.push(
        `  ${padRight(c.id, 14)} ${padRight(c.kind, 13)} ${c.sourceId} -> ${c.targetId}  (${a0},${ar0})->(${a1},${ar1})`,
      );
    }
  }

  return lines.join("\n");
}
