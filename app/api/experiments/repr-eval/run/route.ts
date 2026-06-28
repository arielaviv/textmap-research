/**
 * Eval engine endpoint. Runs the full scenes × models × arms × questions sweep
 * server-side (where deps resolve), grades against the oracle, returns items +
 * aggregate stats. Driven by the batch script and the interactive page.
 *
 *   POST /api/experiments/repr-eval/run
 *   body: { source?, city?, n, models, arms, temperature, repeats, seed, plant, spec }
 *     source "synthetic" (default) | "real" (real OSM via Overpass)
 */

import { NextResponse } from "next/server";
import { fetchRealOSM } from "@/app/api/experiments/repr-eval/osm-fetch";
import {
  type ArmId,
  type EvalConfig,
  runEval,
  selectQuestions,
} from "@/experiments/spatial-repr-eval/core/engine";
import { isVisionModel } from "@/experiments/spatial-repr-eval/core/models";
import { buildRealScene } from "@/experiments/spatial-repr-eval/core/real-scene";
import {
  makeSyntheticScene,
  type Scene,
  type SyntheticSpec,
} from "@/experiments/spatial-repr-eval/core/scene";
import { makeSpecs } from "@/experiments/spatial-repr-eval/core/specs";
import { aggregate, aggregateByModel } from "@/experiments/spatial-repr-eval/core/stats";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

const ALL_ARMS: ArmId[] = ["json", "ascii", "textmap", "image", "verdict"];
const DEFAULT_MODELS = ["claude-sonnet-4-6"];
const MAX_CALLS = 4000;

type Plant = {
  closureInBuilding?: boolean;
  cableCrossing?: boolean;
  coverageGap?: boolean;
  closureOnStreet?: boolean;
};
interface RunBody {
  source?: "synthetic" | "real";
  city?: string;
  n?: number;
  models?: string[];
  arms?: ArmId[];
  temperature?: number;
  repeats?: number;
  seed?: number;
  plant?: Plant;
  spec?: SyntheticSpec; // explicit single synthetic scene (page)
  isolate?: boolean; // drop the JSON baseline — representation-only arms
  questionIds?: string[]; // restrict to specific questions/categories (id or category)
}

const ROTATE: Plant[] = [
  {},
  { closureInBuilding: true },
  { cableCrossing: true },
  { coverageGap: true },
];

export async function POST(req: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "ANTHROPIC_API_KEY not set" }, { status: 500 });

  let body: RunBody;
  try {
    body = (await req.json()) as RunBody;
  } catch {
    body = {};
  }

  const source = body.source ?? "synthetic";
  const models = body.models?.length ? body.models : DEFAULT_MODELS;
  const arms = body.arms?.length ? body.arms : ALL_ARMS;
  const temperature = body.temperature ?? 0;
  const repeats = Math.max(1, Math.min(body.repeats ?? 1, 5));
  const seed = body.seed ?? 1000;
  const n =
    source === "real"
      ? Math.max(1, Math.min(body.n ?? 1, 30))
      : Math.max(1, Math.min(body.n ?? 5, 80));

  const activeQuestionCount = selectQuestions(body.questionIds).length;
  // Non-vision models skip the image arm, so count arms per model.
  const armsFor = (m: string) => arms.filter((a) => a !== "image" || isVisionModel(m)).length;
  const totalCalls =
    n * repeats * activeQuestionCount * models.reduce((sum, m) => sum + armsFor(m), 0);
  if (totalCalls > MAX_CALLS) {
    return NextResponse.json(
      { error: `Refusing ${totalCalls} model calls (cap ${MAX_CALLS}). Lower n/repeats/models.` },
      { status: 400 },
    );
  }

  let scenes: Scene[];
  try {
    scenes = await buildScenes(source, { ...body, n, seed });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "failed to build scenes" },
      { status: 500 },
    );
  }

  const isolate = body.isolate ?? false;
  const config: EvalConfig = {
    apiKey,
    models,
    arms,
    scenes,
    temperature,
    repeats,
    concurrency: 6,
    isolate,
    questionIds: body.questionIds,
  };
  const items = await runEval(config);
  return NextResponse.json({
    config: {
      source,
      city: body.city,
      n,
      models,
      arms,
      temperature,
      repeats,
      seed,
      isolate,
      questionIds: body.questionIds ?? null,
      totalCalls,
    },
    aggregate: aggregate(items),
    perModel: aggregateByModel(items),
    items,
  });
}

async function buildScenes(
  source: "synthetic" | "real",
  body: RunBody & { n: number; seed: number },
): Promise<Scene[]> {
  if (source === "real") {
    const city = body.city ?? "tel-aviv";
    const out: Scene[] = [];
    for (let i = 0; i < body.n; i++) {
      // Skip AOIs that land on water/parks (no buildings) so one bad seed in a
      // 20-scene batch doesn't fail the whole run.
      try {
        const { buildings, streets } = await fetchRealOSM(city, body.seed + i);
        // Always plant one on-road closure so the road_misplacement question has a
        // guaranteed misplacement to find (real scenes also have coincidental ones).
        const plant = {
          ...(body.n === 1 ? body.plant : ROTATE[i % ROTATE.length]),
          closureOnStreet: true,
        };
        out.push(buildRealScene({ id: `scene-${i}`, buildings, streets, maxBuildings: 12, plant }));
      } catch {
        // no buildings in this AOI — skip it
      }
    }
    if (out.length === 0) throw new Error("no buildable scenes — try a different seed/city");
    return out;
  }
  // synthetic
  if (body.spec) {
    return [makeSyntheticScene({ ...body.spec, plant: { ...body.spec.plant, closureOnStreet: true } })];
  }
  return makeSpecs(body.n, body.seed).map((s) =>
    makeSyntheticScene({ ...s, plant: { ...s.plant, closureOnStreet: true } }),
  );
}
