/**
 * SFT scene export — returns ONE fully-built Scene (synthetic or real) for a
 * seed, so the offline SFT data generator can build representations, traces
 * and oracle labels locally without importing the app's R2/alias-bound OSM
 * loader. Same plant policy as the eval run route (rotation + one planted
 * on-road closure) so training scenes match the eval distribution.
 *
 *   POST /api/experiments/repr-eval/sft-scene
 *   body: { seed: number, source?: "synthetic" | "real", city?: string, blocks?: number }
 */

import { NextResponse } from "next/server";
import { checkEvalAuth } from "@/app/api/experiments/repr-eval/auth";
import { fetchRealOSM } from "@/app/api/experiments/repr-eval/osm-fetch";
import { buildRealScene } from "@/experiments/spatial-repr-eval/core/real-scene";
import { makeSyntheticScene, type Scene } from "@/experiments/spatial-repr-eval/core/scene";

export const dynamic = "force-dynamic";

type Plant = { closureInBuilding?: boolean; cableCrossing?: boolean; coverageGap?: boolean };
const ROTATE: Plant[] = [{}, { closureInBuilding: true }, { cableCrossing: true }, { coverageGap: true }];

interface Body {
  seed?: number;
  source?: "synthetic" | "real";
  city?: string;
  blocks?: number;
}

export async function POST(req: Request) {
  const denied = checkEvalAuth(req);
  if (denied) return denied;
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    body = {};
  }
  const seed = body.seed ?? 50000;
  const plant = { ...ROTATE[seed % ROTATE.length], closureOnStreet: true };

  let scene: Scene;
  try {
    if (body.source === "real") {
      const { buildings, streets } = await fetchRealOSM(body.city ?? "nyc", seed, 350);
      scene = buildRealScene({ id: `sft-${seed}`, buildings, streets, maxBuildings: 12, plant });
    } else {
      const blocks = Math.max(1, Math.min(body.blocks ?? 3, 8));
      scene = makeSyntheticScene({ id: `sft-${seed}`, seed, blocksX: blocks, blocksY: blocks, plant });
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "scene build failed" },
      { status: 500 },
    );
  }
  return NextResponse.json({ scene });
}
