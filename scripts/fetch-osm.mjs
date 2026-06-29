/**
 * Fetch a slice of OpenStreetMap buildings + streets for a bbox and write it in
 * the pre-indexed format the repr-eval OSM services expect
 * (data/osm/buildings/{city}.json, data/osm/streets/{city}.json).
 *
 * OSM is public data, so this needs no credentials — it queries the Overpass
 * API directly. Run it once to bundle a slice; re-run with a bigger --bbox to
 * scale the scene up.
 *
 * Usage:
 *   node scripts/fetch-osm.mjs --city new-york --bbox -73.997,40.742,-73.971,40.768
 *   node scripts/fetch-osm.mjs --city new-york            # uses the default midtown bbox
 *
 * --bbox is minLon,minLat,maxLon,maxLat. The default covers the area the eval
 * samples for "nyc" (center -73.984,40.7549 ± ~1km jitter, ~350m boxes).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const DEFAULTS = {
  "new-york": { displayName: "New York", bbox: [-73.997, 40.742, -73.971, 40.768] },
  "tel-aviv": { displayName: "Tel Aviv", bbox: [34.768, 32.07, 34.793, 32.092] },
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--city") out.city = argv[++i];
    else if (argv[i] === "--bbox") out.bbox = argv[++i].split(",").map(Number);
    else if (argv[i] === "--out") out.out = argv[++i];
    else if (argv[i] === "--endpoint") out.endpoint = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const city = args.city ?? "new-york";
const preset = DEFAULTS[city] ?? { displayName: city, bbox: undefined };
const bbox = args.bbox ?? preset.bbox;
if (!bbox || bbox.length !== 4 || bbox.some(Number.isNaN)) {
  console.error(`No bbox for "${city}". Pass --bbox minLon,minLat,maxLon,maxLat`);
  process.exit(1);
}
const [minLon, minLat, maxLon, maxLat] = bbox;
const outDir = args.out ?? "data/osm";
const endpoint = args.endpoint ?? "https://overpass-api.de/api/interpreter";

// Overpass bbox order is south,west,north,east.
const obb = `${minLat},${minLon},${maxLat},${maxLon}`;
const query = `[out:json][timeout:120];
(
  way["building"](${obb});
  way["highway"](${obb});
);
out body geom;`;

function centroid(ring) {
  let x = 0;
  let y = 0;
  for (const [lon, lat] of ring) {
    x += lon;
    y += lat;
  }
  return [x / ring.length, y / ring.length];
}

async function main() {
  console.log(`[fetch-osm] ${city} bbox=${bbox.join(",")} via ${endpoint}`);
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "textmap-research/0.1 (OSM eval fixture generator)",
      Accept: "application/json",
    },
    body: `data=${encodeURIComponent(query)}`,
  });
  if (!res.ok) {
    console.error(`Overpass error ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  const data = await res.json();
  const elements = data.elements ?? [];

  const buildings = [];
  const segments = [];
  for (const el of elements) {
    if (el.type !== "way" || !Array.isArray(el.geometry)) continue;
    const coords = el.geometry.map((g) => [g.lon, g.lat]);
    const tags = el.tags ?? {};
    if (tags.building) {
      if (coords.length < 3) continue;
      buildings.push({
        id: String(el.id),
        center: centroid(coords),
        polygon: coords,
        type: tags.building,
        ...(tags["building:levels"] ? { levels: Number(tags["building:levels"]) } : {}),
        ...(tags["addr:street"] || tags["addr:housenumber"]
          ? {
              address: {
                ...(tags["addr:street"] ? { street: tags["addr:street"] } : {}),
                ...(tags["addr:housenumber"] ? { number: tags["addr:housenumber"] } : {}),
              },
            }
          : {}),
      });
    } else if (tags.highway) {
      if (coords.length < 2) continue;
      segments.push({
        id: String(el.id),
        ...(tags.name ? { name: tags.name } : {}),
        type: tags.highway,
        coordinates: coords,
        oneway: tags.oneway === "yes",
        ...(tags.lanes ? { lanes: Number(tags.lanes) } : {}),
        ...(tags.surface ? { surface: tags.surface } : {}),
      });
    }
  }

  const bboxObj = { south: minLat, west: minLon, north: maxLat, east: maxLon };
  const updated = new Date(data.osm3s?.timestamp_osm_base ?? 0).toISOString();

  const buildingData = {
    city,
    displayName: preset.displayName,
    updated,
    bbox: bboxObj,
    count: buildings.length,
    buildings,
  };

  const totalLength = 0;
  const streetData = {
    city,
    displayName: preset.displayName,
    updated,
    bbox: bboxObj,
    stats: { segments: segments.length, nodes: 0, edges: 0, totalLength },
    segments,
    // The eval reads `segments` only; loadCity just indexes the (empty) graph.
    graph: { nodes: {}, edges: [] },
  };

  const bPath = join(outDir, "buildings", `${city}.json`);
  const sPath = join(outDir, "streets", `${city}.json`);
  mkdirSync(dirname(bPath), { recursive: true });
  mkdirSync(dirname(sPath), { recursive: true });
  writeFileSync(bPath, JSON.stringify(buildingData));
  writeFileSync(sPath, JSON.stringify(streetData));
  console.log(`[fetch-osm] wrote ${buildings.length} buildings -> ${bPath}`);
  console.log(`[fetch-osm] wrote ${segments.length} streets   -> ${sPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
