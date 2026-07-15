/**
 * GeoFM Task-1 external validation (arXiv 2505.17136, GeoDS/GeoFM-TopologicalRelations).
 *
 * Replicates their Task 1 EXACTLY — same 1,400 test triplets (from their published
 * task1_results_all.csv), same system prompt (verbatim from task1-GPT-4.ipynb),
 * same zero-shot regime, same full-triple grading — with ONE variable changed:
 * how the two geometries are written.
 *
 *   arm "wkt"     — their condition: raw WKT strings, byte-identical prompt.
 *   arm "textmap" — the same geometries drawn as two aligned ASCII grid layers.
 *                   Grid + coordinates ONLY: no measurements in any legend —
 *                   a distance would leak the DE-9IM answer.
 *
 * Usage:
 *   node experiments/spatial-repr-eval/geofm-task1.mjs \
 *     --data <dir with relations.csv + task1_results_all.csv> \
 *     --model anthropic/claude-haiku-4.5 --arms wkt,textmap --n 1400 \
 *     --out results/geofm-task1
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Agent, setGlobalDispatcher } from "undici";

setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }));

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}
const dataDir = arg("data", "");
const model = arg("model", "anthropic/claude-haiku-4.5");
const arms = arg("arms", "wkt,textmap").split(",").map((s) => s.trim());
const nItems = Number(arg("n", "1400"));
const concurrency = Number(arg("concurrency", "16"));
const outDir = arg("out", "results/geofm-task1");
const key = process.env.AI_GATEWAY_API_KEY;
if (!dataDir || !key) {
  console.error("need --data <dir> and AI_GATEWAY_API_KEY");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// their exact prompt (verbatim from Code/task1/task1-GPT-4.ipynb, zero_shot)
// ---------------------------------------------------------------------------
const SYSTEM_WKT = `You will be given the WKT format of geometries given the subject A and reference object B.
Classify their spatial relations into one of the following predicates: contains, within, touches, equals, crosses, disjoint, overlaps.
The predicates are defined by DE-9IM and Open Geospatial Consortium. If A equals to B, there is no need to return 'within' or 'contains'.

- Return in the format (Geometry type A, PREDICATE, geometry type B), and nothing else. Geometry types are Point, LineString, Polygon.
- MAKE SURE the PREDICATE in your output is one of the seven predicates stated.`;

// textmap arm: the ONLY changes are (a) "WKT format" -> grid description and
// (b) the geometry block. Question, predicates, output format: identical.
const SYSTEM_TEXTMAP = `You will be given a text-map rendering of geometries given the subject A and reference object B: both are drawn on the SAME aligned grid (one character per cell, space-separated; row 0 = north). LAYER A shows only geometry A ('a' cells); LAYER B shows only geometry B ('b' cells). The layers share the frame — the same (col,row) in both layers is the same place on the ground.
Classify their spatial relations into one of the following predicates: contains, within, touches, equals, crosses, disjoint, overlaps.
The predicates are defined by DE-9IM and Open Geospatial Consortium. If A equals to B, there is no need to return 'within' or 'contains'.

- Return in the format (Geometry type A, PREDICATE, geometry type B), and nothing else. Geometry types are Point, LineString, Polygon.
- MAKE SURE the PREDICATE in your output is one of the seven predicates stated.`;

// ---------------------------------------------------------------------------
// tiny WKT parser (POINT / LINESTRING / POLYGON, as in their dataset)
// ---------------------------------------------------------------------------
function parseWKT(wkt) {
  const m = wkt.trim().match(/^(POINT|LINESTRING|POLYGON)\s*\((.*)\)$/is);
  if (!m) return null;
  const type = m[1].toUpperCase();
  let body = m[2].trim();
  if (type === "POLYGON") body = body.replace(/^\(/, "").replace(/\)$/, "").split("),")[0];
  const coords = body
    .split(",")
    .map((p) => p.trim().split(/\s+/).map(Number))
    .filter((c) => c.length >= 2 && c.every(Number.isFinite));
  return { type, coords };
}

// ---------------------------------------------------------------------------
// two-geometry textmap renderer. Grid + rulers + cell size — NO measurements.
// ---------------------------------------------------------------------------
const COLS = 44;
const ROWS = 26;

function rasterize(geom, grid, cols, rows, toCell) {
  const mark = (c, r) => {
    if (c >= 0 && c < cols && r >= 0 && r < rows) grid[r][c] = true;
  };
  const line = (a, b) => {
    // Bresenham over cell coords
    let [x0, y0] = toCell(a);
    const [x1, y1] = toCell(b);
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      mark(x0, y0);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
  };
  if (geom.type === "POINT") {
    const [c, r] = toCell(geom.coords[0]);
    mark(c, r);
  } else if (geom.type === "LINESTRING") {
    for (let i = 0; i + 1 < geom.coords.length; i++) line(geom.coords[i], geom.coords[i + 1]);
  } else {
    // POLYGON: outline + even-odd fill by cell centres
    for (let i = 0; i + 1 < geom.coords.length; i++) line(geom.coords[i], geom.coords[i + 1]);
    line(geom.coords[geom.coords.length - 1], geom.coords[0]);
  }
}

function fillPolygon(geom, grid, cols, rows, cellCentre) {
  if (geom.type !== "POLYGON") return;
  const ring = geom.coords;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const [x, y] = cellCentre(c, r);
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) grid[r][c] = true;
    }
  }
}

function toTextmapPair(gA, gB) {
  const all = [...gA.coords, ...gB.coords];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of all) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  // 8% margin; degenerate extents get a floor so a lone point still renders
  const padX = Math.max((maxX - minX) * 0.08, 1e-5);
  const padY = Math.max((maxY - minY) * 0.08, 1e-5);
  minX -= padX;
  maxX += padX;
  minY -= padY;
  maxY += padY;
  const cw = (maxX - minX) / COLS;
  const ch = (maxY - minY) / ROWS;
  const toCell = ([x, y]) => [
    Math.min(COLS - 1, Math.max(0, Math.floor((x - minX) / cw))),
    Math.min(ROWS - 1, Math.max(0, Math.floor((maxY - y) / ch))),
  ];
  const cellCentre = (c, r) => [minX + (c + 0.5) * cw, maxY - (r + 0.5) * ch];

  const layer = (geom) => {
    const grid = Array.from({ length: ROWS }, () => Array(COLS).fill(false));
    rasterize(geom, grid, COLS, ROWS, toCell);
    fillPolygon(geom, grid, COLS, ROWS, cellCentre);
    return grid;
  };
  const gridA = layer(gA);
  const gridB = layer(gB);

  const cellM = Math.round(((maxY - minY) / ROWS) * 110540);
  const render = (grid, glyph) => {
    const head = `    ${Array.from({ length: COLS }, (_, i) => (i % 10 === 0 ? String(i / 10) % 10 : ".")).join(" ")}`;
    const rows = grid.map(
      (row, r) =>
        `${String(r).padStart(2, " ")}  ${row.map((v) => (v ? glyph : ".")).join(" ")}  ${String(r).padStart(2, " ")}`,
    );
    return [head, ...rows].join("\n");
  };
  return (
    `TEXT MAP — two ALIGNED layers, one grid frame, north-up. 1 cell ≈ ${cellM}m. ` +
    `col 0..${COLS - 1} = W→E, row 0..${ROWS - 1} = N→S. Cells are space-separated.\n` +
    `GRID REF — cell(col,row) centre = [lng, lat]: lng = ${minX.toFixed(7)} + (col+0.5)*${cw.toExponential(4)}; lat = ${maxY.toFixed(7)} - (row+0.5)*${ch.toExponential(4)}\n\n` +
    `LAYER A — geometry A (${gA.type === "POINT" ? "Point" : gA.type === "LINESTRING" ? "LineString" : "Polygon"}, 'a' cells):\n${render(gridA, "a")}\n\n` +
    `LAYER B — geometry B (${gB.type === "POINT" ? "Point" : gB.type === "LINESTRING" ? "LineString" : "Polygon"}, 'b' cells):\n${render(gridB, "b")}`
  );
}

// ---------------------------------------------------------------------------
// data: their 1,400 test triplets = unique (subjectid, objectid, predicate)
// rows of task1_results_all.csv, joined back to relations.csv for the WKT.
// ---------------------------------------------------------------------------
function parseCsv(text) {
  // minimal RFC-4180 parser (their files quote WKT fields containing commas)
  const rows = [];
  let row = [];
  let field = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') q = false;
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  const header = rows[0];
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

const relations = parseCsv(readFileSync(join(dataDir, "relations.csv"), "utf8"));
const resultsAll = parseCsv(readFileSync(join(dataDir, "task1_results_all.csv"), "utf8"));

const relKey = (s, o, p) => `${s}|${o}|${p}`;
const relByKey = new Map(
  relations.map((r) => [relKey(r.subjectid, r.objectid, r.predicate), r]),
);
const seen = new Set();
const testItems = [];
for (const r of resultsAll) {
  const k = relKey(r.subjectid, r.objectid, r.predicate);
  if (seen.has(k)) continue;
  seen.add(k);
  const rel = relByKey.get(k);
  if (rel) testItems.push(rel);
}
console.log(`their test split: ${testItems.length} triplets (using first ${Math.min(nItems, testItems.length)})`);
const items = testItems.slice(0, nItems);

// ---------------------------------------------------------------------------
// grading — full-triple match like theirs, but extracted as the LAST
// (type, predicate, type) pattern in the answer. DISCLOSED deviation from
// their strict format match: haiku narrates before answering where GPT-4
// obeys "nothing else"; extraction is applied identically to both arms so
// the comparison measures representation, not format obedience.
// ---------------------------------------------------------------------------
function extractTriple(s) {
  if (!s) return null;
  const re =
    /(point|linestring|polygon)\s*,\s*(contains|within|touches|equals|crosses|disjoint|overlaps)\s*,\s*(point|linestring|polygon)/gi;
  let m = null;
  let last = null;
  while (true) {
    m = re.exec(s);
    if (!m) break;
    last = m;
  }
  return last ? `(${last[1]},${last[2]},${last[3]})`.toLowerCase() : null;
}
function labelFor(rel) {
  return `(${rel.geom_type_subject},${rel.predicate},${rel.geom_type})`.toLowerCase();
}

// ---------------------------------------------------------------------------
// gateway call — plain text completion, temp 0, like their setup (no tools)
// ---------------------------------------------------------------------------
async function ask(system, user) {
  const t0 = Date.now();
  const res = await fetch("https://ai-gateway.vercel.sh/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 800,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  const latencyMs = Date.now() - t0;
  if (!res.ok) return { text: null, error: `${res.status}: ${(await res.text()).slice(0, 150)}`, latencyMs };
  const d = await res.json();
  return {
    text: d.choices?.[0]?.message?.content ?? "",
    inputTokens: d.usage?.prompt_tokens ?? 0,
    outputTokens: d.usage?.completion_tokens ?? 0,
    cost: d.usage?.cost ?? 0,
    latencyMs,
  };
}

async function runArm(arm) {
  const rows = [];
  let done = 0;
  const queue = [...items.entries()];
  async function worker() {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      const [i, rel] = next;
      let user;
      let system;
      if (arm === "wkt") {
        system = SYSTEM_WKT;
        user = `\nGeometry A: ${rel.geometry_subject}\nGeometry B: ${rel.geometry}\n`;
      } else {
        const gA = parseWKT(rel.geometry_subject);
        const gB = parseWKT(rel.geometry);
        if (!gA || !gB) {
          rows.push({ i, arm, predicate: rel.predicate, correct: false, error: "wkt-parse" });
          continue;
        }
        system = SYSTEM_TEXTMAP;
        user = `\n${toTextmapPair(gA, gB)}\n`;
      }
      const r = await ask(system, user);
      const correct = !r.error && extractTriple(r.text) === labelFor(rel);
      rows.push({
        i,
        arm,
        subjectid: rel.subjectid,
        objectid: rel.objectid,
        predicate: rel.predicate,
        types: `${rel.geom_type_subject}-${rel.geom_type}`,
        answer: extractTriple(r.text) ?? (r.text ?? "").slice(0, 60),
        correct,
        inputTokens: r.inputTokens ?? 0,
        outputTokens: r.outputTokens ?? 0,
        cost: r.cost ?? 0,
        latencyMs: r.latencyMs,
        error: r.error ?? "",
      });
      done++;
      if (done % 200 === 0) console.log(`  ${arm}: ${done}/${items.length}`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return rows;
}

const t0 = Date.now();
const all = [];
for (const arm of arms) {
  console.log(`arm ${arm}: ${items.length} calls...`);
  all.push(...(await runArm(arm)));
}

mkdirSync(outDir, { recursive: true });
const csvEsc = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const cols = ["arm", "subjectid", "objectid", "predicate", "types", "answer", "correct", "inputTokens", "outputTokens", "cost", "latencyMs", "error"];
writeFileSync(
  join(outDir, "results.csv"),
  [cols.join(","), ...all.map((r) => cols.map((c) => csvEsc(r[c])).join(","))].join("\n"),
);

// report
let report = `# GeoFM Task-1 external validation — ${model}\n\nItems: their ${items.length}-triplet test split, zero-shot, their prompt + grading (full-triple match).\nTheir baselines (recomputed from their per-item outputs): GPT-4 zero-shot 0.628, GPT-4 few-shot 0.661, GPT-3.5 zero-shot 0.369.\n\n`;
for (const arm of arms) {
  const rows = all.filter((r) => r.arm === arm);
  const ok = rows.filter((r) => r.correct).length;
  const errs = rows.filter((r) => r.error).length;
  const cost = rows.reduce((s, r) => s + (Number(r.cost) || 0), 0);
  report += `## ${arm}: ${((100 * ok) / rows.length).toFixed(1)}% (${ok}/${rows.length}, errors ${errs}, cost $${cost.toFixed(2)})\n\n| predicate | acc | n |\n|---|---|---|\n`;
  const preds = [...new Set(rows.map((r) => r.predicate))].sort();
  for (const p of preds) {
    const pr = rows.filter((r) => r.predicate === p);
    report += `| ${p} | ${((100 * pr.filter((r) => r.correct).length) / pr.length).toFixed(0)}% | ${pr.length} |\n`;
  }
  report += "\n";
}
report += `Wall clock: ${((Date.now() - t0) / 60000).toFixed(1)} min\n`;
writeFileSync(join(outDir, "report.md"), report);
console.log(report);
