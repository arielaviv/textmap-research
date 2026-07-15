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
import { checkEvalAuth } from "@/app/api/experiments/repr-eval/auth";
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
import {
  aggregate,
  aggregateByModel,
  aggregateByScale,
} from "@/experiments/spatial-repr-eval/core/stats";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

const ALL_ARMS: ArmId[] = ["json", "ascii", "textmap", "textmap2", "wkt", "image", "verdict"];
const DEFAULT_MODELS = ["claude-sonnet-4-6"];
// Hard guard against runaway sweeps. NOTE: a run near this cap takes hours — far
// beyond Vercel's maxDuration — so big sweeps must target a local dev server
// (run-eval.mjs --url http://localhost:3000), optionally with higher concurrency.
const MAX_CALLS = 20000;

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
  scale?: number[]; // scale sweep: real = AOI sizes in meters; synthetic = blocks per side
  concurrency?: number; // parallel model calls, clamped [1,16]
  includePrompts?: boolean; // attach the (large) prompt/question maps to the response
  hints?: boolean; // append per-category hints (core/hints.ts) to questions
  votes?: number; // majority voting K, clamped [1,5]
  turns?: number; // self-correction rounds, clamped [1,5]
  scan?: boolean; // two-phase scan-then-answer reading
  scanTargets?: boolean; // category-aware extraction briefs for path/on-street (with scan)
  citations?: boolean; // require per-id evidence quotes (grader ignores them)
  zoom?: number; // textmap grid resolution multiplier [1,2] (v2.6, labeled)
  fewshot?: boolean; // prepend a mini worked example in the arm's format
}

const ROTATE: Plant[] = [
  {},
  { closureInBuilding: true },
  { cableCrossing: true },
  { coverageGap: true },
];

export async function POST(req: Request) {
  const denied = checkEvalAuth(req);
  if (denied) return denied;
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
  const repeats = Math.max(1, Math.min(body.repeats ?? 1, 10));
  const concurrency = Math.max(1, Math.min(body.concurrency ?? 6, 16));
  const seed = body.seed ?? 1000;
  const n =
    source === "real"
      ? Math.max(1, Math.min(body.n ?? 1, 60))
      : body.spec
        ? 1 // an explicit spec builds exactly one scene
        : Math.max(1, Math.min(body.n ?? 5, 80));

  const scaleLevels = body.scale?.filter((s) => Number.isFinite(s) && s > 0) ?? [];
  const activeQuestionCount = selectQuestions(body.questionIds).length;
  // Non-vision models skip the image arm, so count arms per model.
  const armsFor = (m: string) => arms.filter((a) => a !== "image" || isVisionModel(m)).length;
  const votes = Math.max(1, Math.min(body.votes ?? 1, 5));
  const turns = Math.max(1, Math.min(body.turns ?? 1, 5));
  // Upper bound: every item uses all votes on every turn (real usage is lower —
  // turns beyond the first fire only on verifier failure).
  const totalCalls =
    n *
    Math.max(1, scaleLevels.length) *
    repeats *
    activeQuestionCount *
    models.reduce((sum, m) => sum + armsFor(m), 0) *
    votes *
    turns;
  if (totalCalls > MAX_CALLS) {
    return NextResponse.json(
      { error: `Refusing ${totalCalls} model calls (cap ${MAX_CALLS}). Lower n/repeats/models.` },
      { status: 400 },
    );
  }

  let scenes: Scene[];
  try {
    scenes = await buildScenes(source, { ...body, n, seed, scale: scaleLevels });
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
    concurrency,
    isolate,
    questionIds: body.questionIds,
    hints: body.hints ?? false,
    votes,
    turns,
    scan: body.scan ?? false,
    scanTargets: body.scanTargets ?? false,
    citations: body.citations ?? false,
    zoom: body.zoom,
    fewshot: body.fewshot ?? false,
  };
  const { items, prompts, questions } = await runEval(config);
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
      scale: scaleLevels.length ? scaleLevels : null,
      hints: body.hints ?? false,
      votes,
      turns,
      scan: body.scan ?? false,
      scanTargets: body.scanTargets ?? false,
      citations: body.citations ?? false,
      zoom: body.zoom ?? 1,
      fewshot: body.fewshot ?? false,
      totalCalls,
    },
    aggregate: aggregate(items),
    perModel: aggregateByModel(items),
    ...(scaleLevels.length ? { perScale: aggregateByScale(items) } : {}),
    items,
    // The prompt/question maps are large (a real-scene json arm is 50-80KB), so
    // they ship only when the caller asks — the batch driver's run log does.
    ...(body.includePrompts ? { prompts, questions } : {}),
  });
}

/** Building budget per AOI size: grows with the square root of the area's linear
 *  scale, capped at 40 (marker letters exhaust at 26; ids/legend stay exact). */
function capForSize(sizeM: number): number {
  return Math.min(40, Math.round(12 * Math.sqrt(sizeM / 350)));
}

async function buildScenes(
  source: "synthetic" | "real",
  body: RunBody & { n: number; seed: number; scale: number[] },
): Promise<Scene[]> {
  if (source === "real") {
    const city = body.city ?? "nyc";
    const out: Scene[] = [];
    // Scale sweep: the SAME n centers (seed-jittered), each at every AOI size —
    // "the same map, larger". No sweep = one ~350m scene per seed.
    const sizes = body.scale.length ? body.scale : [350];
    for (let i = 0; i < body.n; i++) {
      for (const sizeM of sizes) {
        // Skip AOIs that land on water/parks (no buildings) so one bad seed in a
        // 20-scene batch doesn't fail the whole run.
        try {
          const { buildings, streets } = await fetchRealOSM(city, body.seed + i, sizeM);
          // Always plant one on-road closure so the road_misplacement question has a
          // guaranteed misplacement to find (real scenes also have coincidental ones).
          const plant = {
            ...(body.n === 1 ? body.plant : ROTATE[i % ROTATE.length]),
            closureOnStreet: true,
          };
          const scene = buildRealScene({
            id: body.scale.length ? `scene-${i}-s${sizeM}` : `scene-${i}`,
            buildings,
            streets,
            maxBuildings: capForSize(sizeM),
            spread: sizeM > 350,
            plant,
          });
          if (body.scale.length) scene.sizeM = sizeM;
          out.push(scene);
        } catch {
          // no buildings in this AOI — skip it
        }
      }
    }
    if (out.length === 0) throw new Error("no buildable scenes — try a different seed/city");
    return out;
  }
  // synthetic
  if (body.scale.length) {
    // Scale levels = blocks per side (e.g. 2,3,4,5), same seeds at every level.
    const out: Scene[] = [];
    for (let i = 0; i < body.n; i++) {
      for (const lvl of body.scale) {
        const blocks = Math.max(1, Math.min(Math.round(lvl), 8));
        const scene = makeSyntheticScene({
          id: `scene-${i}-b${blocks}`,
          seed: body.seed + i * 17,
          blocksX: blocks,
          blocksY: blocks,
          plant: { ...ROTATE[i % ROTATE.length], closureOnStreet: true },
        });
        scene.sizeM = blocks;
        out.push(scene);
      }
    }
    return out;
  }
  if (body.spec) {
    return [makeSyntheticScene({ ...body.spec, plant: { ...body.spec.plant, closureOnStreet: true } })];
  }
  return makeSpecs(body.n, body.seed).map((s) =>
    makeSyntheticScene({ ...s, plant: { ...s.plant, closureOnStreet: true } }),
  );
}
