/**
 * Pure builder for the Mapbox Static Images URL used by both the eval's image
 * arm and the workspace map tab. Extracted from representations.ts:toMapImage
 * so the workspace can re-render the map from edited DataStore files (not just
 * from a Scene). No fetch here — callers fetch the returned URL.
 */

import type { Scene } from "./scene";

export interface MapGeometry {
  buildings: { footprint: [number, number][]; centroid: [number, number]; label?: string }[];
  streets: { coordinates: [number, number][] }[];
  cables: { path: [number, number][] }[];
  equipment: { kind: string; position: [number, number] }[];
  /** Draw building/street geometry as overlay (synthetic scenes + the workspace,
   *  where the map must reflect edited files rather than a matching basemap). */
  drawBaseGeometry: boolean;
}

/** Equipment marker letters — kept in sync with the textmap legend. */
const MARKER_LETTERS = "abcdefghijklmnopqrstuvwxyz";

export function sceneToMapGeometry(scene: Scene, drawBaseGeometry: boolean): MapGeometry {
  return {
    // Label each building by its index (0,1,… = B-0, B-1, …) so map pins match
    // the textmap markers + the B-ids — findable by eye, distinct from the
    // lowercase closure-letter pins.
    buildings: scene.buildings.map((b, i) => ({
      footprint: b.footprint,
      centroid: b.centroid,
      label: String(i),
    })),
    streets: scene.streets.map((s) => ({ coordinates: s.coordinates })),
    cables: scene.cables.map((c) => ({ path: c.path })),
    equipment: scene.equipment.map((e) => ({ kind: e.kind, position: e.position })),
    drawBaseGeometry,
  };
}

interface OverlayFeature {
  type: "Feature";
  geometry: { type: string; coordinates: unknown };
  properties: Record<string, never>;
}

/**
 * Returns the static-image URL. The geojson overlay degrades to fit Mapbox's
 * ~8k URL limit: full geometry → drop streets → drop buildings → pins only.
 * The labeled pins are always kept; for real scenes the basemap shows the
 * actual streets/buildings underneath, so dropping the overlay loses little.
 * Returns null only if even a pins-only URL doesn't fit (or the scene is empty).
 */
export function buildMapboxStaticUrl(geom: MapGeometry, token: string): string | null {
  // Collapse each layer into ONE multi-geometry feature — dozens of separate
  // Feature wrappers blow the URL budget (encodeURIComponent triples every
  // brace/bracket/comma). One MultiPolygon + two MultiLineStrings is tiny.
  const asMultiLine = (paths: [number, number][][]): OverlayFeature[] =>
    paths.length
      ? [{ type: "Feature", geometry: { type: "MultiLineString", coordinates: paths }, properties: {} }]
      : [];
  const buildingFeats: OverlayFeature[] =
    geom.drawBaseGeometry && geom.buildings.length
      ? [
          {
            type: "Feature",
            geometry: { type: "MultiPolygon", coordinates: geom.buildings.map((b) => [b.footprint]) },
            properties: {},
          },
        ]
      : [];
  const streetFeats: OverlayFeature[] = geom.drawBaseGeometry
    ? asMultiLine(geom.streets.map((s) => s.coordinates))
    : [];
  const cableFeats: OverlayFeature[] = asMultiLine(geom.cables.map((c) => c.path));
  // Thinned cables (endpoints + every other point) for when the full set still
  // overflows on a dense distribution network.
  const thin = (p: [number, number][]): [number, number][] =>
    p.length <= 4 ? p : p.filter((_, i) => i === 0 || i === p.length - 1 || i % 2 === 0);
  const cableFeatsThin: OverlayFeature[] = asMultiLine(geom.cables.map((c) => thin(c.path)));

  const r5 = (n: number): number => Math.round(n * 1e5) / 1e5;
  const markers: string[] = [];
  let letterIdx = 0;
  for (const e of geom.equipment) {
    const lng = r5(e.position[0]);
    const lat = r5(e.position[1]);
    if (e.kind === "co") {
      markers.push(`pin-s-star+f00(${lng},${lat})`); // red star
    } else if (e.kind === "cabinet") {
      markers.push(`pin-s-square+f80(${lng},${lat})`); // orange square — distribution cabinet
    } else {
      const letter = MARKER_LETTERS[letterIdx++] ?? "";
      markers.push(`pin-s${letter ? `-${letter}` : ""}+0a0(${lng},${lat})`); // green letter closure
    }
  }
  for (const b of geom.buildings) {
    const lng = r5(b.centroid[0]);
    const lat = r5(b.centroid[1]);
    const n = b.label && /^\d+$/.test(b.label) ? Number(b.label) : Number.NaN;
    markers.push(
      Number.isFinite(n) && n >= 0 && n <= 99
        ? `pin-s-${n}+00f(${lng},${lat})`
        : `pin-s+00f(${lng},${lat})`,
    );
  }

  const base = "https://api.mapbox.com/styles/v1/mapbox/light-v11/static";
  const tail = `/auto/700x500@2x?access_token=${token}&padding=30`;
  const overlay = (feats: OverlayFeature[]): string =>
    `geojson(${encodeURIComponent(
      JSON.stringify({ type: "FeatureCollection", features: feats }, (_k, v) =>
        typeof v === "number" ? Math.round(v * 1e5) / 1e5 : v,
      ),
    )})`;
  const urlOf = (feats: OverlayFeature[]): string | null => {
    if (feats.length) return `${base}/${[overlay(feats), ...markers].join(",")}${tail}`;
    return markers.length ? `${base}/${markers.join(",")}${tail}` : null;
  };

  // Richest first; drop the heaviest layers until the URL fits. Cables are kept
  // longer than the base geometry (the basemap shows real streets/buildings), and
  // thinned before being dropped entirely.
  const tiers: OverlayFeature[][] = [
    [...buildingFeats, ...streetFeats, ...cableFeats],
    [...buildingFeats, ...cableFeats],
    [...cableFeats],
    [...cableFeatsThin],
    [],
  ];
  for (const feats of tiers) {
    const u = urlOf(feats);
    if (u && u.length <= 8000) return u;
  }
  return null;
}
