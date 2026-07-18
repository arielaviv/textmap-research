/**
 * Eval engine — runs scenes × models × arms × questions and grades each item
 * against the oracle. Shared by the interactive API route and the batch driver
 * so both produce identical, comparable results.
 */

import { fewshotFor } from "./fewshot";
import { executeGeoToolLines, GEO_TOOLS_SPEC } from "./geo-tools";
import { hintFor } from "./hints";
import { askedMissingInfo, hallucinatedIds } from "./metrics";
import { askModel } from "./model";
import { isVisionModel, modelInfo } from "./models";
import { ALL_QUESTIONS, type Answer, type Category, type Question, QUESTIONS } from "./questions";
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
  /** Category-aware scan targets (pipeline v2): path/on-street questions get an
   *  extraction brief matching what they consume (connectivity / placement)
   *  instead of the generic spatial-facts scan. Only meaningful with scan. */
  scanTargets?: boolean;
  /** Geometry-tools arm (function-args executor): one batch tool round — the
   *  model requests planar computations on coordinates IT read from the
   *  representation; pure math executes (never sees the scene) and results
   *  are appended to the answer call. See core/geo-tools.ts. */
  tools?: boolean;
  /** Category-routed tools: the tool round fires ONLY for compute-bound
   *  categories (TOOL_CATEGORIES); read-bound categories keep pure reading. */
  toolsRouted?: boolean;
  /** Executor-verified self-correct loop for the tool round: retry the tool
   *  request (up to min(turns,4)) with feedback whenever the verifier is
   *  unsatisfied. The verifier uses ONLY legitimate signals — tool-call
   *  well-formedness and a coverage bound from the scene's OWN entity counts —
   *  NEVER the oracle, grade, true answer, or planted facts. */
  selfCorrect?: boolean;
  /** v2.7 labeled artifact revision: building footprint bounding boxes
   *  (`ext=` meters) in the textmap legend — exact inputs for the tools arm. */
  extents?: boolean;
  /** v2.8 labeled artifact revision: FOOTPRINTS section with exact outline
   *  vertices (meters) — segment×polygon needs exact rings (probe 2). */
  rings?: boolean;
  /** v2.7 labeled artifact revision: homing topology (`feeds=`) stated on the
   *  source row — closes the path category's unstated-convention gap. */
  feeds?: boolean;
  /** Per-entity world-fact legend fields (`hull=` interior/perimeter) in the
   *  textmap — targets the mixed category's enclosure task. */
  worldFacts?: boolean;
  /** Evidence citations: the answer must cite, per id, the representation line
   *  that justifies it. Grader ignores citations — the forcing function is the
   *  point (careful scanning, less hallucination). */
  citations?: boolean;
  /** Grid resolution multiplier [1,2] for textmap arms — v2.6, a LABELED
   *  artifact revision (smaller cells vs more tokens), not an inference trick. */
  zoom?: number;
  /** Few-shot worked example (GeoFM-proven): a miniature synthetic scene with
   *  two oracle-answered Q→A demonstrations, in the arm's own format. */
  fewshot?: boolean;
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
  /** The scan phase's raw extraction (when scan is on) — logged so the record
   *  shows exactly what the answer call anchored on. */
  scanText?: string;
  /** Tool round record (when tools is on): the model's requests + the computed
   *  results — the full executor audit trail. */
  toolsText?: string;
  error?: string;
}

/** Category-aware scan targets (pipeline v2). Screening showed the generic
 *  "extract spatial facts" scan transforms measurement questions (coverage
 *  20→95, containment 75→95) but collapses connectivity/placement ones (path
 *  90→15, on-street 85→75): the answer call anchors on an extraction that
 *  dropped or garbled the serves graph. For those two categories the scan
 *  extracts the facts the question actually consumes. Wording is
 *  representation-neutral — it names FIELDS the representation may carry, never
 *  scene-specific values, so no ground truth leaks. */
const SCAN_TARGETS: Partial<Record<Category, string>> = {
  path:
    "extract the CONNECTIVITY GRAPH only: one line per equipment entry — its exact id, its " +
    "kind/role exactly as written, and the full list of building/equipment ids it serves " +
    "(if any); one line per cable with its exact id and its two endpoints (source → " +
    "target). Include EVERY equipment entry, even ones that serve nothing (roots/sources " +
    "are part of paths). Do NOT extract positions, distances or streets — this question " +
    "is answered purely by connectivity.",
  "on-street":
    "extract the STREET-PLACEMENT facts only: one line per equipment entry with its exact " +
    "id and every fact the representation states about its position relative to streets " +
    "(the street it sits on, its distance to the nearest street, or its coordinates if " +
    "that is all the representation provides). Do NOT extract serves lists or buildings.",
};

/** Per-question scan overrides (win over the category target). nearest_offstreet
 *  is a two-relation "mixed" task the generic scan collapses; this brief extracts
 *  ONLY the intermediates — the target's home street and each off-street closure's
 *  distance — and explicitly forbids ranking or naming the answer, so no ground
 *  truth is computed in the extraction phase. */
const SCAN_TARGETS_BY_ID: Record<string, string> = {
  nearest_offstreet:
    "identify the target building named in the question and state its HOME STREET (its nearest street from the legend). " +
    "Then list EVERY closure whose OWN nearest street (on=) is DIFFERENT from that home street, each with its distance to the target building. " +
    "Do NOT choose an answer — only extract the home street and this candidate list with distances.",
};

/** Compute-bound categories — where the tools-validation error analysis showed
 *  the executor transforms results (line-intersection 0→90, crossing 35→60,
 *  mixed 36.7→63.3) while read-bound categories regressed under blanket tools. */
const TOOL_CATEGORIES = new Set<Category>(["line-intersection", "crossing", "mixed"]);

/** Tool-mode crossing hint: crossing is answered by the batch geometry executor,
 *  not by reading grid glyphs. Replaces the glyph-reading crossing hint whenever
 *  the executor is active (see hint assembly below). */
const TOOL_CROSSING_HINT =
  "This is answered by the geometry executor, not by reading grid glyphs. Emit ONE " +
  "segments_cross_polygons call: include EVERY cable from CABLES as a segment (use its m[...] " +
  "meter endpoints), EVERY building's FOOTPRINTS ring, and for each cable set exclude to the " +
  "building it terminates at (its terminates_in=, or the target of source -> target when that " +
  "target is a building; else empty). Your answer = the union of cables the tool reports " +
  "crossing a non-excluded building.";

/** Count parseable geometry tool lines (mirrors geo-tools' lenient parser). A
 *  segments_cross_polygons line is credited by its segment count so a truncated
 *  batch (fewer segments than cables) still trips the coverage bound. */
function countToolOps(raw: string): number {
  let n = 0;
  for (const r of raw.split("\n")) {
    const line = r.trim().replace(/^```(json)?|```$/g, "");
    if (!line.startsWith("{")) continue;
    try {
      const o = JSON.parse(line) as { op?: unknown; segments?: unknown };
      if (o && typeof o === "object" && typeof o.op === "string") {
        if (
          o.op === "segments_cross_polygons" &&
          typeof o.segments === "object" &&
          o.segments !== null
        ) {
          n += Object.keys(o.segments as Record<string, unknown>).length;
        } else {
          n++;
        }
      }
    } catch {
      /* ignore */
    }
  }
  return n;
}

/** Minimum tool calls the scene warrants — a COMPLETENESS bound from entity
 *  counts, never the answer. crossing needs one segment test per cable; other
 *  categories only need well-formedness (>=1). */
function minToolOps(q: Question, scene: Scene): number {
  if (q.category === "crossing") return Math.max(1, scene.cables.length);
  return 1;
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
    bundles.set(
      scene.id,
      await buildRepresentations(scene, {
        zoom: config.zoom,
        extents: config.extents,
        rings: config.rings,
        feeds: config.feeds,
        worldFacts: config.worldFacts,
      }),
    );
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
    // Tool routing (prereg 2026-07-17): blanket tools REGRESS read-bound
    // categories (containment 100→70 — the legend precomputes them and the
    // tool round tempts recomputation on self-marshaled inputs). Routed mode
    // fires the executor only where computation is genuinely needed.
    const toolsActive = config.tools && (!config.toolsRouted || TOOL_CATEGORIES.has(q.category));
    let rep = compose(t.arm, bundles.get(t.scene.id)!, config.isolate);
    if (config.fewshot) {
      const example = fewshotFor(t.arm);
      if (example) rep = { ...rep, text: `${example}=== THE REAL SCENE ===\n${rep.text}` };
    }
    // When the executor answers crossing, the glyph-reading crossing hint is
    // replaced by the tool-mode hint (union the batch executor's reported hits).
    let baseQuestion =
      q.prompt(t.scene) +
      (config.hints
        ? toolsActive && q.category === "crossing"
          ? `\nHINT: ${TOOL_CROSSING_HINT}`
          : hintFor(q.id, t.arm)
        : "");
    if (config.citations) {
      baseQuestion +=
        "\nAlso fill `evidence`: for EVERY id in your answer, one string quoting the exact " +
        "line/entry from the representation that justifies including it.";
    }

    let scanTokensIn = 0;
    let scanTokensOut = 0;
    let scanLatency = 0;
    let scanText: string | undefined;
    if (config.scan) {
      // Phase 1: extraction. The model reads the representation and lists the
      // facts relevant to the question — building its own verdict layer.
      // Category-aware target (pipeline v2): the generic "spatial facts" scan
      // collapses connectivity questions — the answer call anchors on an
      // extraction that garbled the serves graph (path 90→15 in screening).
      // The mechanism is unchanged; only WHAT to extract routes by category.
      const target =
        SCAN_TARGETS_BY_ID[q.id] ??
        (config.scanTargets ? SCAN_TARGETS[q.category] : undefined) ??
        "extract from the representation every fact relevant to the question below — " +
          "one line per relevant entity, with its exact ids and measurements as they " +
          "appear. Be complete: cover every entity the question could involve.";
      const scanRes = await askModel({
        apiKey: config.apiKey,
        model: t.model,
        temperature: config.temperature,
        representation: rep,
        question: `Do NOT answer yet. First, ${target}\n\nQUESTION (for context only):\n${q.prompt(t.scene)}`,
        freeText: true,
      });
      scanTokensIn = scanRes.inputTokens;
      scanTokensOut = scanRes.outputTokens;
      scanLatency = scanRes.latencyMs;
      if (scanRes.rawText) {
        scanText = scanRes.rawText;
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

    let toolsText: string | undefined;
    if (toolsActive) {
      // Tool round: the model reads coordinates out of the representation and
      // requests planar computations; pure math runs on exactly what it
      // supplied (a misread coordinate yields an honestly-computed wrong
      // number — the executor never sees the scene). With config.selfCorrect,
      // the round retries when the verifier is unsatisfied. The verifier uses
      // ONLY legitimate signals — tool-call well-formedness and a coverage
      // bound from the scene's OWN entity counts — NEVER the oracle, grade,
      // true answer, or planted facts.
      // Per-category recommendation: point the model at the reducer op that
      // makes the engine (not the LLM) do the filter/argmin/enumerate work.
      let toolNudge = "";
      if (q.category === "crossing" || q.category === "line-intersection")
        toolNudge = "\nPrefer a single segments_cross_polygons call.";
      else if (q.category === "mixed" && q.id === "road_misplacement")
        toolNudge =
          "\nUse filter_threshold over each equipment's d_street= value (cmp le, threshold from the question).";
      else if (q.category === "mixed" && q.id === "nearest_offstreet")
        toolNudge =
          "\nUse nearest_where: target = the building, exclude_value = the building's street=, candidates = each closure with its street=.";
      const toolPrompt =
        "Do NOT answer yet. Decide which geometry computations the question below needs, " +
        "read every required coordinate from the representation, and reply with ONLY JSON " +
        "tool lines.\n" +
        GEO_TOOLS_SPEC +
        `\n\nQUESTION (for context only):\n${q.prompt(t.scene)}` +
        toolNudge;
      const maxToolTurns = config.selfCorrect ? Math.min(Math.max(config.turns ?? 1, 1), 4) : 1;
      let toolFeedback = "";
      let toolResults: string | null = null;
      let lastRaw = "";
      for (let tt = 0; tt < maxToolTurns; tt++) {
        const toolRes = await askModel({
          apiKey: config.apiKey,
          model: t.model,
          temperature: config.temperature,
          representation: rep,
          question: toolFeedback ? `${toolPrompt}\n\n${toolFeedback}` : toolPrompt,
          freeText: true,
          // Ring marshaling can be ~10× a scan's output — its own budget, so
          // scan/answer budgets stay untouched everywhere (probe 3 truncation).
          maxTokensOverride: 6000,
        });
        inputTokens += toolRes.inputTokens;
        outputTokens += toolRes.outputTokens;
        latencyMs += toolRes.latencyMs;
        lastRaw = toolRes.rawText ?? "";
        toolResults = lastRaw ? executeGeoToolLines(lastRaw) : null;
        if (!config.selfCorrect) break;
        const nOps = countToolOps(lastRaw);
        const need = minToolOps(q, t.scene);
        if (nOps === 0) {
          toolFeedback =
            "Your reply contained no valid geometry tool lines. This question REQUIRES computation — " +
            "reply with ONLY JSON tool lines (one per computation), reading exact coordinates from the map.";
          continue;
        }
        if (need > 1 && nOps < Math.ceil(need * 0.6)) {
          toolFeedback =
            `You emitted ${nOps} tool call(s), but this scene has ${need} item(s) that each need a ` +
            "separate check. Test EVERY one — re-read the map and emit a tool line per item.";
          continue;
        }
        break; // verifier satisfied
      }
      if (toolResults) {
        toolsText = `REQUESTS:\n${lastRaw}\n\nRESULTS:\n${toolResults}`;
        baseQuestion +=
          "\n\nGEOMETRY TOOL RESULTS (computed exactly from the coordinates YOU supplied in " +
          `your tool requests — trust these numbers over mental arithmetic):\n${toolResults}`;
      } else if (lastRaw) {
        toolsText = `REQUESTS (no valid tool lines):\n${lastRaw}`;
      }
    }

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

    // A malformed answer must cost ITS item, never the whole run.
    let correct = false;
    let badIds: string[] = [];
    try {
      correct = answer ? q.grade(t.scene, answer) : false;
      badIds = answer ? hallucinatedIds(t.scene, answer) : [];
    } catch {
      error = error ?? "grade-crash: malformed answer";
    }
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
      scanText,
      toolsText,
      error,
    });
    done++;
    onProgress?.(done, tasks.length);
  });

  return { items: results, prompts, questions: questionTexts };
}
