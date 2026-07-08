/**
 * Eval engine — runs scenes × models × arms × questions and grades each item
 * against the oracle. Shared by the interactive API route and the batch driver
 * so both produce identical, comparable results.
 */

import { askedMissingInfo, hallucinatedIds } from "./metrics";
import { askModel } from "./model";
import { isVisionModel } from "./models";
import { type Answer, QUESTIONS } from "./questions";
import { buildRepresentations, type RepresentationBundle } from "./representations";
import type { Scene } from "./scene";

export type ArmId = "json" | "ascii" | "textmap" | "textmap2" | "wkt" | "image" | "verdict";

export interface EvalConfig {
  apiKey: string;
  models: string[];
  arms: ArmId[];
  /** Pre-built scenes (synthetic or real). The caller constructs these. */
  scenes: Scene[];
  temperature: number;
  repeats: number;
  concurrency?: number;
  /** Drop the JSON baseline so each arm sends ONLY its representation — the real
   *  text-only vs json-only vs image-only comparison. */
  isolate?: boolean;
  /** Restrict to specific questions or categories (by id or category name).
   *  Empty/undefined = all questions. Lets you run one category cheaply. */
  questionIds?: string[];
}

/** QUESTIONS filtered by id OR category; all of them when no filter is given. */
export function selectQuestions(filter?: string[]): typeof QUESTIONS {
  if (!filter || filter.length === 0) return QUESTIONS;
  const want = new Set(filter);
  return QUESTIONS.filter((q) => want.has(q.id) || want.has(q.category));
}

export interface ItemResult {
  sceneId: string;
  model: string;
  arm: ArmId;
  questionId: string;
  category: string;
  repeat: number;
  correct: boolean;
  inputTokens: number;
  outputTokens: number;
  /** Wall-clock provider-call time, ms. */
  latencyMs: number;
  /** The answer cited at least one entity id that does not exist in the scene. */
  hallucinated: boolean;
  hallucinatedIds: string[];
  /** The model reported information as missing (non-empty missingInfo field). */
  missingInfo: string | null;
  /** The raw structured answer, kept for the run log. */
  rawAnswer: Answer | null;
  /** AOI size (m) for scale sweeps; null outside a sweep. */
  scaleM: number | null;
  error?: string;
}

/** Compose the text/image a given arm presents to the model. All arms include
 *  the JSON baseline; ascii/verdict append a text layer; image attaches a PNG. */
function compose(
  arm: ArmId,
  bundle: RepresentationBundle,
  isolate = false,
): { text: string; image?: { base64: string; mediaType: "image/png" } } {
  switch (arm) {
    case "json":
      return { text: bundle.json };
    case "ascii":
      return { text: isolate ? bundle.ascii : `${bundle.json}\n\n=== ASCII MAP ===\n${bundle.ascii}` };
    case "textmap":
      return {
        text: isolate ? bundle.textmap : `${bundle.json}\n\n=== TEXT MAP ===\n${bundle.textmap}`,
      };
    case "textmap2":
      return {
        text: isolate
          ? bundle.textmap2
          : `${bundle.json}\n\n=== TEXT MAP v2 ===\n${bundle.textmap2}`,
      };
    case "wkt":
      return { text: isolate ? bundle.wkt : `${bundle.json}\n\n=== WKT ===\n${bundle.wkt}` };
    case "verdict":
      return { text: isolate ? bundle.verdict : `${bundle.json}\n\n${bundle.verdict}` };
    case "image":
      if (!bundle.image) return { text: isolate ? "(no image available)" : bundle.json };
      return {
        text: isolate
          ? "A rendered map image is attached. Answer using only it."
          : `${bundle.json}\n\n(A rendered map image is attached.)`,
        image: bundle.image,
      };
  }
}

async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx]);
    }
  });
  await Promise.all(runners);
}

export interface RunOutput {
  items: ItemResult[];
  /** `${sceneId}|${arm}` → the composed representation text that arm presented
   *  (image arm: the text part only; the PNG itself is not retained). */
  prompts: Record<string, string>;
  /** `${sceneId}|${questionId}` → the rendered question prompt. */
  questions: Record<string, string>;
}

export async function runEval(
  config: EvalConfig,
  onProgress?: (done: number, total: number) => void,
): Promise<RunOutput> {
  const activeQuestions = selectQuestions(config.questionIds);
  const scenes = new Map<string, Scene>();
  const bundles = new Map<string, RepresentationBundle>();
  for (const scene of config.scenes) {
    scenes.set(scene.id, scene);
    bundles.set(scene.id, await buildRepresentations(scene));
  }

  // Prompts are per (scene, arm) — record each once so the run log can cite them
  // without repeating a 50-80KB representation on every item.
  const prompts: Record<string, string> = {};
  const questionTexts: Record<string, string> = {};
  for (const scene of scenes.values()) {
    for (const arm of config.arms) {
      prompts[`${scene.id}|${arm}`] = compose(arm, bundles.get(scene.id)!, config.isolate).text;
    }
    for (const q of activeQuestions) {
      questionTexts[`${scene.id}|${q.id}`] = q.prompt(scene);
    }
  }

  interface Task {
    scene: Scene;
    model: string;
    arm: ArmId;
    qIndex: number;
    repeat: number;
  }
  const tasks: Task[] = [];
  for (const scene of scenes.values()) {
    for (const model of config.models) {
      for (const arm of config.arms) {
        // Text-only models can't see the rendered map — skip the image arm
        // entirely (absent, not scored 0) so it doesn't deflate their numbers.
        if (arm === "image" && !isVisionModel(model)) continue;
        for (let qIndex = 0; qIndex < activeQuestions.length; qIndex++) {
          for (let repeat = 0; repeat < config.repeats; repeat++) {
            tasks.push({ scene, model, arm, qIndex, repeat });
          }
        }
      }
    }
  }

  const results: ItemResult[] = [];
  let done = 0;
  await runPool(tasks, config.concurrency ?? 6, async (t) => {
    const q = activeQuestions[t.qIndex];
    const rep = compose(t.arm, bundles.get(t.scene.id)!, config.isolate);
    const res = await askModel({
      apiKey: config.apiKey,
      model: t.model,
      temperature: config.temperature,
      representation: rep,
      question: q.prompt(t.scene),
    });
    const correct = res.answer ? q.grade(t.scene, res.answer) : false;
    const badIds = res.answer ? hallucinatedIds(t.scene, res.answer) : [];
    results.push({
      sceneId: t.scene.id,
      model: t.model,
      arm: t.arm,
      questionId: q.id,
      category: q.category,
      repeat: t.repeat,
      correct,
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
      latencyMs: res.latencyMs,
      hallucinated: badIds.length > 0,
      hallucinatedIds: badIds,
      missingInfo:
        res.answer && askedMissingInfo(res.answer) ? (res.answer.missingInfo ?? null) : null,
      rawAnswer: res.answer,
      scaleM: t.scene.sizeM ?? null,
      error: res.error,
    });
    done++;
    onProgress?.(done, tasks.length);
  });

  return { items: results, prompts, questions: questionTexts };
}
