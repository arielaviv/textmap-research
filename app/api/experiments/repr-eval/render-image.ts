/**
 * Server-only: render the workspace DataStore files to a Mapbox static-image
 * data URL. Re-derives the map from whatever is currently in the files, so an
 * agent/user edit to buildings.json or equipment.geojson shows up on the map.
 */

import { filesToScene } from "@/experiments/spatial-repr-eval/core/datastore";
import { buildMapboxStaticUrl, sceneToMapGeometry } from "@/experiments/spatial-repr-eval/core/map-url";

export async function renderImageFromFiles(files: Record<string, string>): Promise<string | null> {
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  if (!token) return null;
  const scene = filesToScene(files);
  if (!scene) return null;
  const url = buildMapboxStaticUrl(sceneToMapGeometry(scene, true), token);
  if (!url) return null;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    return `data:image/png;base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}
