/**
 * Seeds the workspace DataStore from a scene: builds the scene (synthetic or
 * real OSM), materializes its files, and renders the initial map image.
 *
 *   POST /api/experiments/repr-eval/chat/seed
 *   body: { source?, city?, seed, blocksX, blocksY, plant, spec? }
 *   → { files: Record<string,string>, image: string|null }
 */

import { NextResponse } from "next/server";
import { checkEvalAuth } from "@/app/api/experiments/repr-eval/auth";
import { fetchRealOSM } from "@/app/api/experiments/repr-eval/osm-fetch";
import { renderImageFromFiles } from "@/app/api/experiments/repr-eval/render-image";
import { sceneToFiles } from "@/experiments/spatial-repr-eval/core/datastore";
import { buildRealScene } from "@/experiments/spatial-repr-eval/core/real-scene";
import {
  makeSyntheticScene,
  type Scene,
  type SyntheticSpec,
} from "@/experiments/spatial-repr-eval/core/scene";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Plant = { closureInBuilding?: boolean; cableCrossing?: boolean; coverageGap?: boolean };
interface SeedBody {
  source?: "synthetic" | "real";
  city?: string;
  seed?: number;
  blocksX?: number;
  blocksY?: number;
  plant?: Plant;
  spec?: SyntheticSpec;
}

export async function POST(req: Request) {
  const denied = checkEvalAuth(req);
  if (denied) return denied;
  let body: SeedBody = {};
  try {
    body = (await req.json()) as SeedBody;
  } catch {
    /* defaults */
  }

  let scene: Scene;
  try {
    if (body.source === "real") {
      const { buildings, streets } = await fetchRealOSM(body.city ?? "nyc", body.seed ?? 42);
      scene = buildRealScene({ id: "ws", buildings, streets, maxBuildings: 12, plant: body.plant });
    } else if (body.spec) {
      scene = makeSyntheticScene(body.spec);
    } else {
      scene = makeSyntheticScene({
        id: "ws",
        seed: body.seed ?? 42,
        blocksX: body.blocksX ?? 3,
        blocksY: body.blocksY ?? 3,
        plant: body.plant,
      });
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "failed to build scene" },
      { status: 500 },
    );
  }

  const files = sceneToFiles(scene);
  const image = await renderImageFromFiles(files);
  // Whether the GeoGlyph SFT endpoint is configured — the UI greys the selector
  // entry when false, and the chat route refuses to call HF when unset.
  const sftAvailable = Boolean(process.env.HF_SFT_URL && process.env.HF_TOKEN);
  return NextResponse.json({ files, image, sftAvailable });
}
