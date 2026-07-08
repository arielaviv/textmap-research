/**
 * Builds the four representation arms from a single Scene.
 *
 *   A. json    — the structured files the data-strip agent actually reads
 *   B. ascii   — the REAL zone text-twin (generateZoneAsciiGrid)
 *   C. image   — a rendered Mapbox static map (base64) for the vision encoder
 *   D. verdict — a computed spatial-predicate ledger (the recommended alternative)
 *
 * Imports the real generator from app/services, so this module runs inside
 * Next (the API route), where pnpm/webpack resolution works.
 */

import {
  DEFAULT_ZONE_SIZE,
  divideIntoZones,
  type GridSymbolConfig,
  generateZoneAsciiGrid,
  selectGridResolution,
} from "@/app/services/zone-text-twin";
import type {
  InfrastructureBuilding,
  InfrastructureRoad,
  ZoneBounds,
  ZoneEquipment,
  ZoneFeature,
} from "@/app/types/geocodebase";
import {
  cablesCrossingForeignBuildings,
  closuresInsideBuildings,
  coverageGapBuildings,
  distanceToNearestStreet,
  nearestClosureToBuilding,
} from "./oracle";
import { buildMapboxStaticUrl, sceneToMapGeometry } from "./map-url";
import type { EquipmentKind, Scene } from "./scene";
import { toTextMap } from "./textmap";

export interface RepresentationBundle {
  json: string;
  ascii: string;
  textmap: string;
  wkt: string;
  verdict: string;
  image: { base64: string; mediaType: "image/png" } | null;
  imageNote?: string;
}

const GLYPH: Record<EquipmentKind, string> = { co: "★", cabinet: "◆", closure: "●" };

const SYMBOL_CONFIG: GridSymbolConfig = {
  entitySymbols: { co: "★", cabinet: "◆", closure: "●" },
  annotationPrefixes: { co: "O", cabinet: "C", closure: "L" },
};

// ---------------------------------------------------------------------------
// A. JSON — mirrors the files the agent reads from the DataStore
// ---------------------------------------------------------------------------

export function toJSON(scene: Scene): string {
  const buildings = scene.buildings.map((b) => ({
    id: b.id,
    type: b.type,
    floors: b.floors,
    position: b.centroid,
    coordinates: [b.footprint],
    address: b.address,
  }));
  const streets = scene.streets.map((s) => ({
    id: s.id,
    name: s.name,
    coordinates: s.coordinates,
  }));
  const equipment = {
    type: "FeatureCollection",
    features: scene.equipment.map((e) => ({
      type: "Feature",
      id: e.id,
      geometry: { type: "Point", coordinates: e.position },
      properties: { kind: e.kind, serves: e.serves },
    })),
  };
  const cables = {
    type: "FeatureCollection",
    features: scene.cables.map((c) => ({
      type: "Feature",
      id: c.id,
      geometry: { type: "LineString", coordinates: c.path },
      properties: { kind: c.kind, source: c.sourceId, target: c.targetId },
    })),
  };
  return [
    "=== buildings.json ===",
    JSON.stringify(buildings),
    "=== streets.json ===",
    JSON.stringify(streets),
    "=== layers/equipment.geojson ===",
    JSON.stringify(equipment),
    "=== layers/cables.geojson ===",
    JSON.stringify(cables),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// B. ASCII — the real zone text-twin generator
// ---------------------------------------------------------------------------

export function toAscii(scene: Scene): string {
  // Tile the area into ~200m zones (A1, B2, …) exactly like schema-map's zone
  // text-twin, rendering each non-empty zone as its own square grid. Small
  // scenes collapse to a single zone. This matches the framing you remember.
  const { zoneBounds } = divideIntoZones(scene.bounds, DEFAULT_ZONE_SIZE);
  const inZone = (c: [number, number], b: ZoneBounds): boolean =>
    c[0] >= b.minLng && c[0] <= b.maxLng && c[1] >= b.minLat && c[1] <= b.maxLat;

  const parts: string[] = [];
  for (const zoneId of [...zoneBounds.keys()].sort()) {
    const zb = zoneBounds.get(zoneId);
    if (!zb) continue;

    const zBuildings = scene.buildings.filter((b) => inZone(b.centroid, zb));
    const zEquip = scene.equipment.filter((e) => inZone(e.position, zb));
    if (zBuildings.length === 0 && zEquip.length === 0) continue;
    const zStreets = scene.streets.filter((s) => s.coordinates.some((c) => inZone(c, zb)));
    const zCables = scene.cables.filter((c) => c.path.some((p) => inZone(p, zb)));

    // Give the GRID a standardized id (CITY-ZONE-TYPE-SEQ) so the generator
    // prints a clean [●07] label instead of [●??] (getGridId only annotates the
    // standardized format). Render-only: SEQ mirrors the scene id's number
    // (CL-7 → 007 → shown as 07) so the marker still correlates with the CL-7 in
    // the JSON baseline. Grading uses the real scene ids, untouched.
    const typeCode = (k: EquipmentKind): string =>
      k === "co" ? "CO" : k === "cabinet" ? "CB" : "CL";
    const nodes: ZoneEquipment[] = zEquip.map((e, idx) => {
      const seq = Number(e.id.match(/(\d+)$/)?.[1] ?? idx);
      return {
        id: `Z-${zoneId}-${typeCode(e.kind)}-${String(seq).padStart(3, "0")}`,
        symbol: GLYPH[e.kind],
        type: e.kind,
        coordinates: e.position,
        gridPosition: [0, 0],
        properties: { serves: e.serves },
      };
    });
    const cables: ZoneFeature[] = zCables.map((c) => ({
      type: "Feature",
      id: c.id,
      geometry: { type: "LineString", coordinates: c.path },
      properties: { cableType: c.kind, source: c.sourceId, target: c.targetId },
    }));
    const roads: InfrastructureRoad[] = zStreets.map((s) => ({
      id: s.id,
      name: s.name,
      type: "residential",
      coordinates: s.coordinates,
      width: 8,
    }));
    const buildings: InfrastructureBuilding[] = zBuildings.map((b) => ({
      id: b.id,
      coordinates: [b.footprint],
      centroid: b.centroid,
      type: b.type === "commercial" ? "commercial" : "residential",
      floors: b.floors,
    }));

    const res = selectGridResolution(zBuildings.length);
    const { grid } = generateZoneAsciiGrid(
      zb,
      nodes,
      cables,
      { roads, buildings },
      [],
      [],
      false,
      SYMBOL_CONFIG,
      res.gridWidth,
      res.gridHeight,
    );
    parts.push(
      `ZONE ${zoneId} (${DEFAULT_ZONE_SIZE.width}m × ${DEFAULT_ZONE_SIZE.height}m)\n${grid}`,
    );
  }

  return parts.length ? parts.join("\n\n") : "(no spatial features)";
}

// ---------------------------------------------------------------------------
// F. WKT — well-known-text geometry table
// ---------------------------------------------------------------------------

// WKT carries geometry only, so attributes ride in a TSV column alongside it —
// the standard "WKT column in a CSV" GIS interchange shape. Same information
// content as the JSON arm, different encoding.
export function toWKT(scene: Scene): string {
  const fmt = (c: [number, number]): string => `${c[0].toFixed(7)} ${c[1].toFixed(7)}`;
  const line = (coords: [number, number][]): string => coords.map(fmt).join(", ");
  const ring = (footprint: [number, number][]): string => {
    const [first] = footprint;
    const last = footprint[footprint.length - 1];
    const closed =
      first && last && (first[0] !== last[0] || first[1] !== last[1])
        ? [...footprint, first]
        : footprint;
    return line(closed);
  };

  const rows: string[] = ["id\ttype\tattrs\twkt"];
  for (const b of scene.buildings) {
    const addr = b.address ? `;addr=${b.address.number} ${b.address.street}` : "";
    rows.push(
      `${b.id}\tbuilding\tuse=${b.type};floors=${b.floors}${addr}\tPOLYGON((${ring(b.footprint)}))`,
    );
  }
  for (const s of scene.streets) {
    rows.push(`${s.id}\tstreet\tname=${s.name}\tLINESTRING(${line(s.coordinates)})`);
  }
  for (const e of scene.equipment) {
    rows.push(
      `${e.id}\tequipment\tkind=${e.kind};serves=[${e.serves.join(",")}]\tPOINT(${fmt(e.position)})`,
    );
  }
  for (const c of scene.cables) {
    rows.push(
      `${c.id}\tcable\tkind=${c.kind};source=${c.sourceId};target=${c.targetId}\tLINESTRING(${line(c.path)})`,
    );
  }
  return rows.join("\n");
}

// ---------------------------------------------------------------------------
// D. Verdict — computed spatial-predicate ledger
// ---------------------------------------------------------------------------

export function toVerdict(scene: Scene): string {
  const inside = new Set(closuresInsideBuildings(scene));
  const crossing = new Set(cablesCrossingForeignBuildings(scene));
  const gaps = new Set(coverageGapBuildings(scene));

  const eqRows = scene.equipment.map((e) => {
    const dStreet = distanceToNearestStreet(scene, e.id);
    return `${e.id} (${e.kind}) on_street=${dStreet <= 8} dist_to_street=${dStreet.toFixed(1)}m inside_building=${inside.has(e.id)} serves=[${e.serves.join(",")}]`;
  });
  const cableRows = scene.cables.map(
    (c) =>
      `${c.id} (${c.kind}) ${c.sourceId}->${c.targetId} crosses_foreign_building=${crossing.has(c.id)}`,
  );
  const bldgRows = scene.buildings.map(
    (b) =>
      `${b.id} type=${b.type} nearest_closure=${nearestClosureToBuilding(scene, b.id) ?? "none"} coverage_gap=${gaps.has(b.id)}`,
  );

  return [
    "=== EQUIPMENT (computed spatial predicates) ===",
    ...eqRows,
    "=== CABLES ===",
    ...cableRows,
    "=== BUILDINGS ===",
    ...bldgRows,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// C. Image — Mapbox Static Images render of the scene
// ---------------------------------------------------------------------------

export async function toMapImage(
  scene: Scene,
): Promise<{ base64: string; mediaType: "image/png" } | null> {
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  if (!token) return null;
  // For REAL scenes the buildings + streets ARE the basemap (real OSM at real
  // coords), so overlay only the network + pins; for SYNTHETIC the geometry is
  // invented, so draw it.
  const url = buildMapboxStaticUrl(sceneToMapGeometry(scene, scene.kind === "synthetic"), token);
  if (!url) return null;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    return { base64: buf.toString("base64"), mediaType: "image/png" };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Assemble all arms
// ---------------------------------------------------------------------------

export async function buildRepresentations(scene: Scene): Promise<RepresentationBundle> {
  const image = await toMapImage(scene);
  return {
    json: toJSON(scene),
    ascii: toAscii(scene),
    textmap: toTextMap(scene),
    wkt: toWKT(scene),
    verdict: toVerdict(scene),
    image,
    imageNote: image
      ? undefined
      : "image unavailable (no NEXT_PUBLIC_MAPBOX_TOKEN or URL too long)",
  };
}
