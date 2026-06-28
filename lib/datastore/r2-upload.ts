/**
 * Local stub of the edison object-storage helper.
 *
 * In the edison product this module reads pre-indexed OSM city extracts from R2.
 * The repr-eval research surface only needs `getObjectText` (used by the OSM
 * services to load `osm/buildings/{city}.json` / `osm/streets/{city}.json` on the
 * server). This stub keeps the research repo free of the product datastore: if an
 * `OSM_DATA_BASE_URL` is configured it fetches `{base}/{key}`, otherwise it throws
 * so callers (which already catch and return `false`) degrade gracefully — the
 * real-OSM routes simply report no pre-indexed data.
 */
export async function getObjectText(key: string): Promise<string> {
  const base = process.env.OSM_DATA_BASE_URL;
  if (!base) {
    throw new Error(
      `[r2-upload stub] No OSM_DATA_BASE_URL configured; cannot load "${key}". ` +
        "Pre-indexed OSM data is unavailable in textmap-research.",
    );
  }
  const url = `${base.replace(/\/$/, "")}/${key}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`[r2-upload stub] Failed to fetch ${url}: ${res.status}`);
  }
  return res.text();
}
