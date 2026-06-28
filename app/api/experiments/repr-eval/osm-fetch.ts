/**
 * Server-only OSM fetch for real eval scenes.
 *
 * Uses the R2-backed lookups (osmBuildingLookup / osmStreetGraph) that the
 * product's scans rely on — pre-indexed OSM read from object storage. This is
 * reliable on Vercel, unlike live Overpass, which rate-limits cloud IPs (the
 * old path silently returned empty → "no buildings").
 */

import * as turf from "@turf/turf";
import { osmBuildingLookup } from "@/app/services/osm-building-lookup";
import { osmStreetGraph } from "@/app/services/osm-street-graph";
import {
  aoiForCity,
  type RawBuilding,
  type RawStreet,
} from "@/experiments/spatial-repr-eval/core/real-scene";

/** Page city key → R2 city key. */
function cityKeyFor(city: string): string {
  return city === "nyc" ? "new-york" : city;
}

/**
 * The R2 lookup flattens OSM address to a single `"<number> <street>"` string.
 * Split the leading house-number token back out so the image pin can label it
 * (Mapbox pin labels take a 0–99 number) and the text legend can show both.
 */
function parseAddr(s?: string): { number?: string; street?: string } | undefined {
  if (!s) return undefined;
  const m = s.match(/^(\d+\S*)\s+(.+)$/);
  if (m) return { number: m[1], street: m[2] };
  return { street: s };
}

export interface OsmAoi {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

/** Fetch OSM buildings + streets inside an explicit AOI bbox. */
export async function fetchRealOSMByAoi(
  city: string,
  aoi: OsmAoi,
): Promise<{ buildings: RawBuilding[]; streets: RawStreet[] }> {
  const cityKey = cityKeyFor(city);
  const poly = turf.bboxPolygon([aoi.minLon, aoi.minLat, aoi.maxLon, aoi.maxLat]);

  await osmBuildingLookup.loadCity(cityKey);
  await osmStreetGraph.loadCity(cityKey);

  const buildings: RawBuilding[] = osmBuildingLookup
    .getBuildingsInPolygon(poly)
    .filter((b) => b.polygon && b.polygon.length >= 3)
    .map((b) => ({
      id: `b-${b.id}`,
      geometry: b.polygon as [number, number][],
      address: parseAddr(b.address),
    }));

  const streets: RawStreet[] = osmStreetGraph.getStreetsInPolygon(poly).map((s) => ({
    id: String(s.id),
    name: s.name,
    geometry: s.coordinates as [number, number][],
  }));

  return { buildings, streets };
}

export async function fetchRealOSM(
  city: string,
  seed: number,
): Promise<{ buildings: RawBuilding[]; streets: RawStreet[] }> {
  return fetchRealOSMByAoi(city, aoiForCity(city, seed));
}
