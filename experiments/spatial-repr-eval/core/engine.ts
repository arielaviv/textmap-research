/**
 * Eval engine — runs scenes × models × arms × questions and grades each item
 * against the oracle. Shared by the interactive API route and the batch driver
 * so both produce identical, comparable results.
 */

import { hintFor } from "./hints";
import { askedMissingInfo, hallucinatedIds } from "./metrics";
import { askModel } from "./model";
import { isVisionModel, modelInfo } from "./models";
import { ALL_QUESTIONS, type Answer, QUESTIONS } from "./questions";
import { buildRepresentations, type RepresentationBundle } from "./representations";
import type { Scene } from "./scene";

export type ArmId =
  | "json"
  | "ascii"
  | "textmap"
  | "textmap2"
  | "textmap2np"
  | "wkt"
  | "image"
  | "verdict";

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
  /** Append per-category, arm-specific hints (core/hints.ts) to the question.
   *  Hints teach HOW TO READ a representation, never scene facts. */
  hints?: boolean;
  /** Majority voting: K samples at temp 0.7, majority answer wins. Degenerates
   *  to 1 for models that reject temperature (identical samples). */
  votes?: number;
  /** Self-correction rounds (max 5). The verifier uses ONLY representation-
   *  legal signals (nonexistent ids, missing answer) — NEVER the oracle;
   *  looping "until correct" would leak ground truth. */
  turns?: number;
  /** Two-phase scan-then-answer: an extraction call first ("list the relevant
   *  facts"), then the answer call reasons over the model's OWN extraction.
   *  Turns the verdict-ceiling insight into an inference strategy — the model
   *  builds its own verdict layer. No scene facts are injected. */
  scan?: boolean;
  /** Evidence citations: the answer must cite, per id, the representation line
   *  that justifies it. Grader ignores citations — the forcing function is the
   *  point (careful scanning, less hallucination). */
  citations?: boolean;
  /** Grid resolution multiplier [1,2] for textmap arms — v2.6, a LABELED
   *  artifact revision (smaller cells vs more tokens), not an inference trick. */
  zoom?: number;
}

/** Questions filtered by id OR category. No filter = the frozen 10-question
 *  protocol; hold-out questions (category "holdout") run ONLY when named. */
export function selectQuestions(filter?: string[]): typeof QUESTIONS {
  if (!filter || filter.length === 0) return QUESTIONS;
  const want = new Set(filter);
  return ALL_QUESTIONS.filter((q) => want.has(q.id) || want.has(q.category));
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
  /** Pipeline accounting: samples drawn (voting) and correction rounds used. */
  votesUsed?: number;
  turnsUsed?: number;
  error?: string;
}

/** Canonical answer key for majority voting: array fields sorted, metadata
 *  dropped, so semantically-equal answers vote together. */
function answerKey(a: Answer): string {
  const sort = (xs?: string[]) => (xs ? [...xs].sort() : undefined);
  return JSON.stringify({
    e: sort(a.equipmentIds),
    c: sort(a.cableIds),
    b: sort(a.buildingIds),
    cl: a.closureId,
    os: a.onStreet,
    p: a.equipmentPath, // order matters — not sorted
    n: a.count,
    d: a.direction?.trim().toLowerCase(),
    q: a.quadrant?.trim().toUpperCase(),
  });
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
    case "textmap2np":
      return {
        text: isolate
          ? bundle.textmap2np
          : `${bundle.json}

=== TEXT MAP v2 (no protocol) ===
${bundle.textmap2np}`,
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
    bundles.set(scene.id, await buildRepresentations(scene, { zoom: config.zoom }));
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
  const maxTurns = Math.min(Math.max(config.turns ?? 1, 1), 5);
  const votesWanted = Math.min(Math.max(config.votes ?? 1, 1), 5);

  await runPool(tasks, config.concurrency ?? 6, async (t) => {
    const q = activeQuestions[t.qIndex];
    const rep = compose(t.arm, bundles.get(t.scene.id)!, config.isolate);
    let baseQuestion = q.prompt(t.scene) + (config.hints ? hintFor(q.id, t.arm) : "");
    if (config.citations) {
      baseQuestion +=
        "\nAlso fill `evidence`: for EVERY id in your answer, one string quoting the exact " +
        "line/entry from the representation that justifies including it.";
    }

    let scanTokensIn = 0;
    let scanTokensOut = 0;
    let scanLatency = 0;
    if (config.scan) {
      // Phase 1: extraction. The model reads the representation and lists the
      // facts relevant to the question — building its own verdict layer.
      const scanRes = await askModel({
        apiKey: config.apiKey,
        model: t.model,
        temperature: config.temperature,
        representation: rep,
        question:
          "Do NOT answer yet. First, extract from the representation every fact relevant " +
          "to the question below — one line per relevant entity, with its exact ids and " +
          "measurements as they appear. Be complete: cover every entity the question could " +
          `involve.\n\nQUESTION (for context only):\n${q.prompt(t.scene)}`,
        freeText: true,
      });
      scanTokensIn = scanRes.inputTokens;
      scanTokensOut = scanRes.outputTokens;
      scanLatency = scanRes.latencyMs;
      if (scanRes.rawText) {
        baseQuestion =
          `${baseQuestion}\n\nYOUR OWN EXTRACTED FACTS (from your first read — re-verify ` +
          `anything doubtful against the representation):\n${scanRes.rawText}`;
      }
    }
    // Voting needs sampling diversity — temp-0 (and no-temp) models produce
    // identical votes, so K degenerates to 1 there.
    const votes = modelInfo(t.model).acceptsTemperature === false ? 1 : votesWanted;

    let inputTokens = scanTokensIn;
    let outputTokens = scanTokensOut;
    let latencyMs = scanLatency;
    let answer: Answer | null = null;
    let error: string | undefined;
    let turnsUsed = 0;
    let feedback = "";

    for (let turn = 0; turn < maxTurns; turn++) {
      turnsUsed = turn + 1;
      const question = feedback ? `${baseQuestion}\n\n${feedback}` : baseQuestion;

      // One attempt = K samples (majority) or a single deterministic call.
      const sampled: Answer[] = [];
      for (let v = 0; v < votes; v++) {
        const res = await askModel({
          apiKey: config.apiKey,
          model: t.model,
          temperature: votes > 1 ? 0.7 : config.temperature,
          representation: rep,
          question,
        });
        inputTokens += res.inputTokens;
        outputTokens += res.outputTokens;
        latencyMs += res.latencyMs;
        if (res.answer) sampled.push(res.answer);
        else error = res.error;
      }
      if (sampled.length === 0) break; // every sample errored — keep error

      if (sampled.length === 1) {
        answer = sampled[0];
      } else {
        const tally = new Map<string, { n: number; a: Answer }>();
        for (const a of sampled) {
          const k = answerKey(a);
          const cur = tally.get(k);
          if (cur) cur.n++;
          else tally.set(k, { n: 1, a });
        }
        answer = [...tally.values()].sort((x, y) => y.n - x.n)[0].a;
      }
      error = undefined;

      // Verifier — representation-legal signals ONLY (never the oracle):
      // nonexistent ids are the one hard error a reader can be told about.
      const badIds = hallucinatedIds(t.scene, answer);
      if (badIds.length === 0) break;
      feedback =
        `PREVIOUS ATTEMPT: ${JSON.stringify(answer)}\n` +
        `FEEDBACK: the ids [${badIds.join(", ")}] do not exist in this scene. ` +
        "Re-read the representation and answer again using only ids that appear in it.";
    }

    const correct = answer ? q.grade(t.scene, answer) : false;
    const badIds = answer ? hallucinatedIds(t.scene, answer) : [];
    results.push({
      sceneId: t.scene.id,
      model: t.model,
      arm: t.arm,
      questionId: q.id,
      category: q.category,
      repeat: t.repeat,
      correct,
      inputTokens,
      outputTokens,
      latencyMs,
      hallucinated: badIds.length > 0,
      hallucinatedIds: badIds,
      missingInfo: answer && askedMissingInfo(answer) ? (answer.missingInfo ?? null) : null,
      rawAnswer: answer,
      scaleM: t.scene.sizeM ?? null,
      votesUsed: votes,
      turnsUsed,
      error,
    });
    done++;
    onProgress?.(done, tasks.length);
  });

  return { items: results, prompts, questions: questionTexts };
}
