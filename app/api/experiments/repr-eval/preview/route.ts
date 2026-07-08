/**
 * Single-scene preview for the interactive page: returns the four representation
 * arms (json/ascii/verdict text + base64 image) and the oracle ground truth per
 * question. No model calls — purely for visual inspection / demo.
 *
 *   POST /api/experiments/repr-eval/preview
 *   body: { source?, city?, seed, blocksX, blocksY, plant }
 */

import { NextResponse } from "next/server";
import { fetchRealOSM } from "@/app/api/experiments/repr-eval/osm-fetch";
import {
  cablesCrossingForeignBuildings,
  closuresInsideBuildings,
  coverageGapBuildings,
  equipmentInRoad,
  interiorBuildings,
  isOnStreet,
  lineCrossesBuildings,
  nearestClosureOffStreet,
  nearestClosureToBuilding,
  nearestStreetIsNamed,
  pathToSource,
} from "@/experiments/spatial-repr-eval/core/oracle";
import { buildRealScene } from "@/experiments/spatial-repr-eval/core/real-scene";
import { buildRepresentations } from "@/experiments/spatial-repr-eval/core/representations";
import { makeSyntheticScene, type Scene } from "@/experiments/spatial-repr-eval/core/scene";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

interface PreviewBody {
  source?: "synthetic" | "real";
  city?: string;
  seed?: number;
  blocksX?: number;
  blocksY?: number;
  /** Real scenes: AOI size in meters (scale-sweep eyeballing). Default ~350. */
  sizeM?: number;
  plant?: {
    closureInBuilding?: boolean;
    cableCrossing?: boolean;
    coverageGap?: boolean;
    closureOnStreet?: boolean;
  };
}

export async function POST(req: Request) {
  let body: PreviewBody = {};
  try {
    body = (await req.json()) as PreviewBody;
  } catch {
    /* defaults */
  }

  let scene: Scene;
  try {
    if (body.source === "real") {
      const sizeM = body.sizeM && body.sizeM > 0 ? body.sizeM : 350;
      const { buildings, streets } = await fetchRealOSM(body.city ?? "nyc", body.seed ?? 42, sizeM);
      scene = buildRealScene({
        id: "preview",
        buildings,
        streets,
        maxBuildings: Math.min(40, Math.round(12 * Math.sqrt(sizeM / 350))),
        spread: sizeM > 350,
        plant: body.plant,
      });
    } else {
      scene = makeSyntheticScene({
        id: "preview",
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

  const reps = await buildRepresentations(scene);
  const firstClosure = scene.equipment.find((e) => e.kind === "closure")?.id ?? "none";
  const b0 = scene.buildings[0].id;
  const topoB =
    scene.buildings.find((b) =>
      scene.equipment.some((e) => e.kind === "closure" && e.serves.includes(b.id)),
    )?.id ?? b0;

  const co = scene.equipment.find((e) => e.kind === "co");
  let blockTarget = scene.buildings[scene.buildings.length - 1];
  if (co) {
    let bd = -1;
    for (const b of scene.buildings) {
      const d = Math.hypot(b.centroid[0] - co.position[0], b.centroid[1] - co.position[1]);
      if (d > bd) {
        bd = d;
        blockTarget = b;
      }
    }
  }
  const truths = {
    containment: closuresInsideBuildings(scene),
    crossing: cablesCrossingForeignBuildings(scene),
    onstreet: { equipment: firstClosure, onStreet: isOnStreet(scene, firstClosure) },
    nearest: { building: b0, closure: nearestClosureToBuilding(scene, b0) },
    coverage_gap: coverageGapBuildings(scene),
    road_misplacement: equipmentInRoad(scene),
    topology: { building: topoB, path: pathToSource(scene, topoB) },
    blockage: {
      from: co?.id ?? "CO-1",
      to: blockTarget.id,
      crosses: co ? lineCrossesBuildings(scene, co.position, blockTarget.centroid, blockTarget.id) : [],
    },
    enclosure: interiorBuildings(scene),
    nearest_offstreet: (() => {
      const t =
        scene.buildings.find((b) => nearestStreetIsNamed(scene, b.centroid))?.id ??
        scene.buildings[0].id;
      return { building: t, closure: nearestClosureOffStreet(scene, t) };
    })(),
  };

  return NextResponse.json({
    kind: scene.kind,
    summary: {
      buildings: scene.buildings.length,
      streets: scene.streets.length,
      equipment: scene.equipment.length,
      cables: scene.cables.length,
    },
    representations: {
      json: reps.json,
      ascii: reps.ascii,
      textmap: reps.textmap,
      wkt: reps.wkt,
      verdict: reps.verdict,
      image: reps.image ? `data:image/png;base64,${reps.image.base64}` : null,
      imageNote: reps.imageNote ?? null,
    },
    truths,
  });
}
