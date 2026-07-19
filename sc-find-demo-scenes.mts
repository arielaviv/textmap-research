// Locate the exact training scenes behind the two demo transcripts (page §9)
// by rebuilding seeds 60000+ deterministically and matching the textmap
// document byte-for-byte, then dump their FULL geometry (buildings, streets,
// equipment, cables) so the page can render the scenes completely.
import fs from "node:fs";
import { fetchRealOSMByAoi } from "./app/api/experiments/repr-eval/osm-fetch";
import { buildRealScene } from "./experiments/spatial-repr-eval/core/real-scene";
import type { Scene } from "./experiments/spatial-repr-eval/core/scene";
import { toTextMapV2 } from "./experiments/spatial-repr-eval/core/textmap";

// --- tile math copied from sft-generate-v2.mts (that file runs main() on import) ---
const hash32 = (str: string): number => {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};
const lcgFrom = (seed: number): (() => number) => {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s / 4294967296;
  };
};
interface Box { minLon: number; minLat: number; maxLon: number; maxLat: number }
const SLICE: Box = { minLon: -74.011, minLat: 40.732, maxLon: -73.957, maxLat: 40.778 };
const NYC: [number, number] = [-73.984, 40.7549];
const boxAround = (lng: number, lat: number, sizeM: number): Box => {
  const halfLat = sizeM / 2 / 110540;
  const halfLng = sizeM / 2 / (111320 * Math.cos((lat * Math.PI) / 180));
  return { minLon: lng - halfLng, maxLon: lng + halfLng, minLat: lat - halfLat, maxLat: lat + halfLat };
};
const intersects = (a: Box, b: Box): boolean =>
  a.minLon < b.maxLon && a.maxLon > b.minLon && a.minLat < b.maxLat && a.maxLat > b.minLat;
const LATTICE: Box[] = Array.from({ length: 100 }, (_, r) => {
  const jLng = (((r * 73) % 100) / 100 - 0.5) * 0.02;
  const jLat = (((r * 91) % 100) / 100 - 0.5) * 0.02;
  return boxAround(NYC[0] + jLng, NYC[1] + jLat, 550);
});
function trainAoi(seed: number): Box {
  const rand = lcgFrom(hash32(`tile|${seed}`));
  const half = boxAround(SLICE.minLon, (SLICE.minLat + SLICE.maxLat) / 2, 350);
  const mLon = (half.maxLon - half.minLon) / 2 + 0.001;
  const mLat = (half.maxLat - half.minLat) / 2 + 0.001;
  for (let a = 0; a < 500; a++) {
    const lng = SLICE.minLon + mLon + rand() * (SLICE.maxLon - SLICE.minLon - 2 * mLon);
    const lat = SLICE.minLat + mLat + rand() * (SLICE.maxLat - SLICE.minLat - 2 * mLat);
    const box = boxAround(lng, lat, 350);
    if (!LATTICE.some((l) => intersects(box, l))) return box;
  }
  throw new Error(`no tile for ${seed}`);
}
// -------------------------------------------------------------------------------

const DEMO_PATH = "C:/Users/ariel/Desktop/GeoGlyph-Results/demo-transcripts.json";
const demo = JSON.parse(fs.readFileSync(DEMO_PATH, "utf8")) as Record<
  string,
  { messages: { role: string; content: string }[]; geo?: unknown }
>;

const docOf = (row: { messages: { content: string }[] }): string => {
  let d = row.messages[1].content.split("\n\nQUESTION:")[0];
  const i = d.indexOf("\nAvailable ops");
  if (i >= 0) d = d.slice(0, i).trimEnd();
  return d;
};
const targets = new Map<string, string>([
  ["read", docOf(demo.read)],
  ["compute", docOf(demo.compute)],
]);

const geoOf = (s: Scene) => ({
  buildings: s.buildings.map((b) => ({ id: b.id, coordinates: [b.footprint] })),
  streets: s.streets.map((st) => ({ id: st.id, name: st.name, coordinates: st.coordinates })),
  equipment: {
    features: s.equipment.map((e) => ({
      id: e.id,
      geometry: { type: "Point", coordinates: e.position },
      properties: { kind: e.kind },
    })),
  },
  cables: {
    features: s.cables.map((c) => ({ id: c.id, geometry: { type: "LineString", coordinates: c.path } })),
  },
});

async function main(): Promise<void> {
  const ROTATE = [{}, { closureInBuilding: true }, { cableCrossing: true }, { coverageGap: true }];
  let found = 0;
  for (let i = 0; i < 240 && found < targets.size; i++) {
    const seed = 60000 + i;
    let scene: Scene;
    try {
      const { buildings, streets } = await fetchRealOSMByAoi("nyc", trainAoi(seed));
      scene = buildRealScene({
        id: `t-${seed}`,
        buildings,
        streets,
        maxBuildings: 8 + (i % 7),
        plant: { ...ROTATE[i % 4], closureOnStreet: i % 2 === 0 },
      });
    } catch {
      continue;
    }
    const doc = toTextMapV2(scene, { zoom: 1, rings: true, feeds: true, worldFacts: true });
    for (const [name, target] of targets) {
      if (doc === target && !demo[name].geo) {
        demo[name].geo = geoOf(scene);
        found++;
        console.log(`matched ${name} -> seed ${seed} (${scene.buildings.length} buildings, ${scene.streets.length} streets)`);
      }
    }
  }
  fs.writeFileSync(DEMO_PATH, JSON.stringify(demo, null, 1), "utf8");
  console.log(`done: ${found}/${targets.size} matched`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
export {};
