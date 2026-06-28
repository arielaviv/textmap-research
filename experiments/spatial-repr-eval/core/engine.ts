/**
 * Eval engine — runs scenes × models × arms × questions and grades each item
 * against the oracle. Shared by the interactive API route and the batch driver
 * so both produce identical, comparable results.
 */

import { askModel } from "./model";
import { isVisionModel } from "./models";
import { QUESTIONS } from "./questions";
import { buildRepresentations, type RepresentationBundle } from "./representations";
import type { Scene } from "./scene";

export type ArmId = "json" | "ascii" | "textmap" | "image" | "verdict";

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

export async function runEval(
  config: EvalConfig,
  onProgress?: (done: number, total: number) => void,
): Promise<ItemResult[]> {
  const activeQuestions = selectQuestions(config.questionIds);
  const scenes = new Map<string, Scene>();
  const bundles = new Map<string, RepresentationBundle>();
  for (const scene of config.scenes) {
    scenes.set(scene.id, scene);
    bundles.set(scene.id, await buildRepresentations(scene));
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
      error: res.error,
    });
    done++;
    onProgress?.(done, tasks.length);
  });

  return results;
}
