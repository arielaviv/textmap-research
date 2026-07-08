"use client";

/**
 * Interactive spatial-representation eval page.
 * Lets you build a scene, inspect the four representation arms side-by-side,
 * and run the model on each arm with live per-question grading vs the oracle.
 *
 * The rigorous statistics come from the batch driver (run-eval.mjs); this page
 * is for inspection and demos.
 */

import { useState } from "react";
import { BENCHMARK_MODELS, MODELS } from "@/experiments/spatial-repr-eval/core/models";
import { ScaleChart, type ScalePoint } from "./scale-chart";
import { WorkspaceTab } from "./workspace-tab";

type Arm = "json" | "ascii" | "textmap" | "wkt" | "image" | "verdict";
const ARMS: Arm[] = ["json", "ascii", "textmap", "wkt", "image", "verdict"];

interface PreviewResp {
  summary: { buildings: number; streets: number; equipment: number; cables: number };
  representations: {
    json: string;
    ascii: string;
    textmap: string;
    wkt: string;
    verdict: string;
    image: string | null;
    imageNote: string | null;
  };
  truths: Record<string, unknown>;
}
interface RunItem {
  sceneId?: string;
  model?: string;
  arm: Arm;
  questionId: string;
  category: string;
  repeat?: number;
  correct: boolean;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  hallucinated?: boolean;
  hallucinatedIds?: string[];
  missingInfo?: string | null;
  rawAnswer?: Record<string, unknown> | null;
  scaleM?: number | null;
  error?: string;
}
interface ArmSummary {
  arm: string;
  n: number;
  correct: number;
  acc: number;
  lo: number;
  hi: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  avgLatencyMs: number;
  hallucinationRate: number;
  missingInfoRate: number;
}
interface ArmCategorySummary {
  arm: string;
  category: string;
  n: number;
  acc: number;
  lo: number;
  hi: number;
}
interface Pairwise {
  armA: string;
  armB: string;
  accA: number;
  accB: number;
  mcnemar: { b: number; c: number; statistic: number; p: number };
}
interface Aggregate {
  perArm: ArmSummary[];
  perArmCategory: ArmCategorySummary[];
  pairwise: Pairwise[];
  totalItems: number;
  errors: number;
}
interface ModelAgg extends Aggregate {
  model: string;
}
interface RunResp {
  items: RunItem[];
  config?: { n?: number; totalCalls?: number };
  aggregate: Aggregate;
  perModel?: ModelAgg[];
  perScale?: ScalePoint[];
  prompts?: Record<string, string>;
  questions?: Record<string, string>;
}

/** Client-side file download — no server round-trip. */
function downloadBlob(filename: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const csvField = (v: unknown): string => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function runToCsv(run: RunResp): string {
  const header =
    "sceneId,model,arm,questionId,category,repeat,correct,inputTokens,outputTokens,latencyMs,hallucinated,hallucinatedIds,missingInfo,scaleM,error";
  const rows = run.items.map((r) =>
    [
      r.sceneId ?? "",
      r.model ?? "",
      r.arm,
      r.questionId,
      r.category,
      r.repeat ?? "",
      r.correct,
      r.inputTokens ?? "",
      r.outputTokens ?? "",
      r.latencyMs ?? "",
      r.hallucinated ?? "",
      (r.hallucinatedIds ?? []).join("|"),
      csvField(r.missingInfo ?? ""),
      r.scaleM ?? "",
      csvField(r.error ?? ""),
    ].join(","),
  );
  return [header, ...rows].join("\n");
}

function runToJsonl(run: RunResp): string {
  const lines: string[] = [JSON.stringify({ type: "config", ...(run.config ?? {}) })];
  for (const [key, text] of Object.entries(run.prompts ?? {})) {
    lines.push(JSON.stringify({ type: "prompt", key, text }));
  }
  for (const [key, text] of Object.entries(run.questions ?? {})) {
    lines.push(JSON.stringify({ type: "question", key, text }));
  }
  for (const item of run.items) lines.push(JSON.stringify({ type: "item", ...item }));
  return `${lines.join("\n")}\n`;
}

const CATEGORIES = [
  "containment",
  "crossing",
  "on-street",
  "nearest",
  "coverage",
  "path",
  "line-intersection",
  "mixed",
] as const;
const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;

const QUESTION_IDS = [
  "containment",
  "crossing",
  "onstreet",
  "nearest",
  "coverage_gap",
  "topology",
  "road_misplacement",
  "blockage",
  "enclosure",
  "nearest_offstreet",
];

export default function ReprEvalPage() {
  const [seed, setSeed] = useState(42);
  const [blocksX, setBlocksX] = useState(3);
  const [blocksY, setBlocksY] = useState(3);
  const [plantInBuilding, setPlantInBuilding] = useState(false);
  const [plantCrossing, setPlantCrossing] = useState(false);
  const [plantGap, setPlantGap] = useState(false);
  const [model, setModel] = useState("claude-sonnet-4-6");
  const [source, setSource] = useState<"synthetic" | "real">("real");
  const [city, setCity] = useState("nyc");
  const [scenes, setScenes] = useState(20);
  const [isolate, setIsolate] = useState(true);
  const [includePrompts, setIncludePrompts] = useState(false);
  const [scaleSweep, setScaleSweep] = useState(false);
  const [scaleLevels, setScaleLevels] = useState("350,700,1400,2800");
  const [onlyCat, setOnlyCat] = useState(""); // "" = all questions; else a category or question id
  // Benchmark sweep runs across many models; `model` (Anthropic-only) still drives the workspace.
  const [evalModels, setEvalModels] = useState<string[]>(BENCHMARK_MODELS);
  const [selModel, setSelModel] = useState<string>(BENCHMARK_MODELS[0]);
  const [topTab, setTopTab] = useState<"workspace" | "eval">("workspace");

  const [preview, setPreview] = useState<PreviewResp | null>(null);
  const [run, setRun] = useState<RunResp | null>(null);
  const [loading, setLoading] = useState<"" | "preview" | "run">("");
  const [err, setErr] = useState<string | null>(null);

  const plant = {
    closureInBuilding: plantInBuilding || undefined,
    cableCrossing: plantCrossing || undefined,
    coverageGap: plantGap || undefined,
  };
  const previewBody =
    source === "real" ? { source, city, seed, plant } : { source, seed, blocksX, blocksY, plant };
  const seedBody =
    source === "real"
      ? { source, city, seed, plant }
      : { source, spec: { id: "ws", seed, blocksX, blocksY, plant } };
  const questionIds = onlyCat ? [onlyCat] : undefined;
  const scale = scaleSweep
    ? scaleLevels
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((x) => Number.isFinite(x) && x > 0)
    : undefined;
  const runBody =
    source === "real"
      ? {
          source,
          city,
          seed,
          n: scenes,
          plant,
          models: evalModels,
          arms: ARMS,
          repeats: 1,
          temperature: 0,
          isolate,
          questionIds,
          includePrompts,
          scale,
        }
      : {
          source,
          ...(scale ? { n: scenes, seed } : { spec: { id: "preview", seed, blocksX, blocksY, plant } }),
          models: evalModels,
          arms: ARMS,
          repeats: 1,
          temperature: 0,
          isolate,
          questionIds,
          includePrompts,
          scale,
        };

  async function loadPreview() {
    setLoading("preview");
    setErr(null);
    setRun(null);
    try {
      const r = await fetch("/api/experiments/repr-eval/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(previewBody),
      });
      if (!r.ok) throw new Error(await r.text());
      setPreview((await r.json()) as PreviewResp);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading("");
    }
  }

  async function runArms() {
    setLoading("run");
    setErr(null);
    try {
      const r = await fetch("/api/experiments/repr-eval/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(runBody),
      });
      if (!r.ok) throw new Error(await r.text());
      setRun((await r.json()) as RunResp);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading("");
    }
  }

  const cell = (arm: Arm, q: string): RunItem | undefined =>
    run?.items.find((i) => i.arm === arm && i.questionId === q);

  return (
    <div className="min-h-screen bg-white p-6 text-zinc-900">
      <h1 className="mb-1 text-xl font-semibold">Spatial Representation Eval</h1>
      <p className="mb-4 text-sm text-zinc-600">
        Does the representation format change how well the model reads spatial relationships?
        Inspect the arms, then run the model. For a statistically meaningful result set source to
        real OSM and <code>scenes</code> to ~20 — Run reports Wilson CIs + paired McNemar.
      </p>

      {/* Controls */}
      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-zinc-300 bg-white p-3 text-sm">
        <label className="flex flex-col">
          <span className="text-zinc-600">source</span>
          <select
            value={source}
            onChange={(e) => setSource(e.target.value as "synthetic" | "real")}
            className="rounded border border-zinc-300 bg-white px-2 py-1"
          >
            <option value="synthetic">synthetic</option>
            <option value="real">real OSM</option>
          </select>
        </label>
        {source === "real" && (
          <label className="flex flex-col">
            <span className="text-zinc-600">city</span>
            <select
              value={city}
              onChange={(e) => setCity(e.target.value)}
              className="rounded border border-zinc-300 bg-white px-2 py-1"
            >
              <option value="nyc">new york</option>
              <option value="tel-aviv">tel-aviv</option>
            </select>
          </label>
        )}
        {source === "real" && (
          <label className="flex flex-col">
            <span className="text-zinc-600">scenes (Run)</span>
            <input
              type="number"
              value={scenes}
              min={1}
              max={30}
              onChange={(e) => setScenes(Math.max(1, Math.min(30, +e.target.value)))}
              className="w-20 rounded border border-zinc-300 bg-white px-2 py-1"
              title="How many real OSM scenes Run arms evaluates. Each uses seed+i and rotates the planted error (none/closure-in-building/cable-crossing/coverage-gap). 20 is the safe sweet spot; 30 may approach the 800s limit."
            />
          </label>
        )}
        <label className="flex flex-col">
          <span className="text-zinc-600">seed</span>
          <input
            type="number"
            value={seed}
            onChange={(e) => setSeed(+e.target.value)}
            className="w-20 rounded border border-zinc-300 bg-white px-2 py-1"
          />
        </label>
        <label className="flex flex-col">
          <span className="text-zinc-600">blocksX</span>
          <input
            type="number"
            value={blocksX}
            min={1}
            max={5}
            disabled={source === "real"}
            onChange={(e) => setBlocksX(+e.target.value)}
            className="w-16 rounded border border-zinc-300 bg-white px-2 py-1 disabled:opacity-40"
          />
        </label>
        <label className="flex flex-col">
          <span className="text-zinc-600">blocksY</span>
          <input
            type="number"
            value={blocksY}
            min={1}
            max={5}
            disabled={source === "real"}
            onChange={(e) => setBlocksY(+e.target.value)}
            className="w-16 rounded border border-zinc-300 bg-white px-2 py-1 disabled:opacity-40"
          />
        </label>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={plantInBuilding}
            onChange={(e) => setPlantInBuilding(e.target.checked)}
          />{" "}
          closure-in-building
        </label>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={plantCrossing}
            onChange={(e) => setPlantCrossing(e.target.checked)}
          />{" "}
          cable-crossing
        </label>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={plantGap}
            onChange={(e) => setPlantGap(e.target.checked)}
          />{" "}
          coverage-gap
        </label>
        <label className="flex flex-col">
          <span className="text-zinc-600">model</span>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="rounded border border-zinc-300 bg-white px-2 py-1"
          >
            <optgroup label="Anthropic">
              <option value="claude-sonnet-4-6">sonnet-4-6</option>
              <option value="claude-opus-4-8">opus-4-8</option>
              <option value="claude-haiku-4-5-20251001">haiku-4-5</option>
            </optgroup>
            <optgroup label="Gateway (needs AI_GATEWAY_API_KEY)">
              <option value="openai/gpt-4o">openai/gpt-4o</option>
              <option value="openai/gpt-4o-mini">openai/gpt-4o-mini</option>
              <option value="google/gemini-2.5-flash">google/gemini-2.5-flash</option>
              <option value="moonshotai/kimi-k2">moonshotai/kimi-k2</option>
              <option value="deepseek/deepseek-chat">deepseek/deepseek-chat</option>
            </optgroup>
          </select>
        </label>
      </div>

      {/* Top-level tabs */}
      <div className="mb-4 flex gap-1 border-zinc-200 border-b">
        {(["workspace", "eval"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTopTab(t)}
            className={`px-4 py-2 text-sm ${topTab === t ? "border-zinc-800 border-b-2 text-zinc-900" : "text-zinc-600 hover:text-zinc-900"}`}
          >
            {t === "workspace" ? "Workspace" : "Eval"}
          </button>
        ))}
      </div>

      {/* key={model} remounts on model switch → clears chat/transcript so the
          Anthropic-block vs OpenAI-message transcript formats never mix. */}
      {topTab === "workspace" && <WorkspaceTab key={model} sceneBody={seedBody} model={model} />}

      {topTab === "eval" && (
        <>
          <div className="mb-4 flex gap-3">
            <button
              type="button"
              onClick={loadPreview}
              disabled={!!loading}
              className="rounded bg-zinc-200 px-3 py-1.5 text-sm hover:bg-zinc-300 disabled:opacity-50"
            >
              {loading === "preview" ? "Loading…" : "Load scene"}
            </button>
            <button
              type="button"
              onClick={runArms}
              disabled={!!loading || !preview}
              className="rounded bg-emerald-600 px-3 py-1.5 text-sm text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              {loading === "run" ? "Running…" : "Run arms"}
            </button>
            <label className="flex items-center gap-1.5 text-sm" title="Each arm sees ONLY its representation (no JSON baseline) — the real text-vs-json-vs-image test.">
              <input
                type="checkbox"
                checked={isolate}
                onChange={(e) => setIsolate(e.target.checked)}
              />
              isolate (drop JSON baseline)
            </label>
            <label
              className="flex items-center gap-1.5 text-sm"
              title="Ship the composed prompt of every scene × arm with the response so the JSONL download is a complete run record (large at high n)."
            >
              <input
                type="checkbox"
                checked={includePrompts}
                onChange={(e) => setIncludePrompts(e.target.checked)}
              />
              include prompts
            </label>
            <label
              className="flex items-center gap-1.5 text-sm"
              title="Run every scene at each AOI size (real: meters; synthetic: blocks per side) — same centers, growing maps. The headline test: whose token cost grows, whose accuracy holds."
            >
              <input
                type="checkbox"
                checked={scaleSweep}
                onChange={(e) => setScaleSweep(e.target.checked)}
              />
              scale sweep
            </label>
            {scaleSweep && (
              <input
                value={scaleLevels}
                onChange={(e) => setScaleLevels(e.target.value)}
                aria-label="Scale levels"
                placeholder={source === "real" ? "350,700,1400,2800" : "2,3,4,5"}
                className="w-44 rounded border border-zinc-300 bg-white px-2 py-1 font-mono text-xs"
              />
            )}
            <label
              className="flex items-center gap-1.5 text-sm"
              title="Run only one category or question to save tokens and isolate a result."
            >
              only:
              <select
                value={onlyCat}
                onChange={(e) => setOnlyCat(e.target.value)}
                className="rounded border border-zinc-300 bg-white px-2 py-1"
              >
                <option value="">all questions</option>
                <optgroup label="category">
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="single question">
                  {QUESTION_IDS.map((q) => (
                    <option key={q} value={q}>
                      {q}
                    </option>
                  ))}
                </optgroup>
              </select>
            </label>
          </div>
          <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-zinc-600">models:</span>
            {MODELS.map((m) => (
              <label
                key={m.id}
                className="flex items-center gap-1 rounded border border-zinc-300 px-1.5 py-0.5"
                title={m.vision ? m.id : `${m.id} — no vision, image arm skipped`}
              >
                <input
                  type="checkbox"
                  checked={evalModels.includes(m.id)}
                  onChange={(e) =>
                    setEvalModels((cur) =>
                      e.target.checked ? [...cur, m.id] : cur.filter((x) => x !== m.id),
                    )
                  }
                />
                {m.label}
                {!m.vision && <span className="text-zinc-400">·txt</span>}
              </label>
            ))}
          </div>
          {isolate && (
            <div className="mb-3 text-xs text-zinc-500">
              isolate = each arm sees ONLY its representation — this is the real
              text-vs-json-vs-image test (otherwise every arm also gets the JSON, so X can't help).
            </div>
          )}

      {err && (
        <div className="mb-4 rounded border border-red-300 bg-red-50 p-2 text-sm text-red-700">
          {err}
        </div>
      )}

      {preview && (
        <>
          <div className="mb-2 text-xs text-zinc-500">
            {preview.summary.buildings} buildings · {preview.summary.streets} streets ·{" "}
            {preview.summary.equipment} equipment · {preview.summary.cables} cables
          </div>

          {/* Run results */}
          {run &&
            (() => {
              const perModel: ModelAgg[] = run.perModel ?? [{ model: selModel, ...run.aggregate }];
              const agg = perModel.find((m) => m.model === selModel) ?? perModel[0];
              const armAcc = (m: ModelAgg, arm: string): number | undefined =>
                m.perArm.find((a) => a.arm === arm)?.acc;
              const singleScene = agg.totalItems <= QUESTION_IDS.length * ARMS.length;
              const catAcc = (arm: string, category: string): ArmCategorySummary | undefined =>
                agg.perArmCategory.find((r) => r.arm === arm && r.category === category);
              return (
                <div className="mb-4 space-y-3">
                  {/* Full-run exports — the paper's artifact trail */}
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => downloadBlob("results.csv", runToCsv(run), "text/csv")}
                      className="rounded border border-zinc-300 bg-white px-2.5 py-1 text-xs hover:bg-zinc-100"
                    >
                      download CSV
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        downloadBlob("runlog.jsonl", runToJsonl(run), "application/jsonl")
                      }
                      className="rounded border border-zinc-300 bg-white px-2.5 py-1 text-xs hover:bg-zinc-100"
                    >
                      download run log (JSONL)
                    </button>
                    {!run.prompts && (
                      <span className="text-[11px] text-zinc-400">
                        tip: check "include prompts" before running for a complete JSONL record
                      </span>
                    )}
                  </div>

                  {/* Scale sweep — the paper's headline figure */}
                  {run.perScale && run.perScale.length > 0 && (
                    <div className="overflow-x-auto rounded-lg border border-zinc-300 bg-white p-3">
                      <div className="mb-1 text-sm font-medium">
                        Scale sweep — accuracy vs input tokens
                        {(run.perModel?.length ?? 1) > 1 ? " (all models pooled)" : ""}
                      </div>
                      <div className="mb-2 text-xs text-zinc-500">
                        Same map centers at every size. Structured geometry (json/wkt) pays tokens
                        for scale; the question is whose accuracy holds per token spent.
                      </div>
                      <ScaleChart data={run.perScale} />
                      <table className="mt-3 text-sm">
                        <thead>
                          <tr className="text-zinc-600">
                            <th className="px-2 text-left">scale</th>
                            <th className="px-2 text-left">arm</th>
                            <th className="px-3">acc</th>
                            <th className="px-3">95% CI</th>
                            <th className="px-3">n</th>
                            <th className="px-3">tok in</th>
                            <th className="px-3">latency</th>
                          </tr>
                        </thead>
                        <tbody>
                          {run.perScale.map((s) => (
                            <tr key={`${s.scaleM}-${s.arm}`} className="border-t border-zinc-200">
                              <td className="px-2 py-1 text-zinc-600">{s.scaleM}m</td>
                              <td className="px-2 py-1">{s.arm}</td>
                              <td className="px-3 py-1 text-center font-medium">{pct(s.acc)}</td>
                              <td className="px-3 py-1 text-center text-zinc-600">
                                {pct(s.lo)}–{pct(s.hi)}
                              </td>
                              <td className="px-3 py-1 text-center text-zinc-600">{s.n}</td>
                              <td className="px-3 py-1 text-center text-zinc-500">
                                {s.avgInputTokens.toLocaleString()}
                              </td>
                              <td className="px-3 py-1 text-center text-zinc-500">
                                {(s.avgLatencyMs / 1000).toFixed(1)}s
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {/* Benchmark matrix: model × arm accuracy (blank = image arm skipped, no vision) */}
                  {perModel.length > 1 && (
                    <div className="overflow-x-auto rounded-lg border border-zinc-300 bg-white p-3">
                      <div className="mb-2 font-medium text-sm">
                        Accuracy by model × arm{isolate ? " (isolate)" : ""}
                      </div>
                      <table className="text-sm">
                        <thead>
                          <tr className="text-zinc-600">
                            <th className="px-2 text-left">model</th>
                            {ARMS.map((a) => (
                              <th key={a} className="px-3">
                                {a}
                              </th>
                            ))}
                            <th className="px-3">tok in</th>
                            <th className="px-3">latency</th>
                          </tr>
                        </thead>
                        <tbody>
                          {perModel.map((mm) => {
                            const meanIn = mm.perArm.length
                              ? Math.round(
                                  mm.perArm.reduce((s, a) => s + a.avgInputTokens, 0) /
                                    mm.perArm.length,
                                )
                              : 0;
                            const meanLat = mm.perArm.length
                              ? mm.perArm.reduce((s, a) => s + (a.avgLatencyMs ?? 0), 0) /
                                mm.perArm.length
                              : 0;
                            return (
                              <tr key={mm.model} className="border-zinc-200 border-t">
                                <td className="px-2 py-1 font-mono text-xs">{mm.model}</td>
                                {ARMS.map((a) => {
                                  const acc = armAcc(mm, a);
                                  return (
                                    <td key={a} className="px-3 py-1 text-center">
                                      {acc === undefined ? (
                                        <span className="text-zinc-300">·</span>
                                      ) : (
                                        pct(acc)
                                      )}
                                    </td>
                                  );
                                })}
                                <td className="px-3 py-1 text-center text-zinc-500">{meanIn}</td>
                                <td className="px-3 py-1 text-center text-zinc-500">
                                  {(meanLat / 1000).toFixed(1)}s
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                      <div className="mt-2 text-xs text-zinc-500">
                        Headline: does text ≫ image and text ≈ json hold ACROSS models? Blank image
                        cell = text-only model (no vision). Pick a model below for CIs + McNemar.
                      </div>
                    </div>
                  )}

                  {/* Which model the detailed tables below describe */}
                  {perModel.length > 1 && (
                    <label className="flex items-center gap-1.5 text-sm">
                      detail model:
                      <select
                        value={selModel}
                        onChange={(e) => setSelModel(e.target.value)}
                        className="rounded border border-zinc-300 bg-white px-2 py-1 font-mono text-xs"
                      >
                        {perModel.map((mm) => (
                          <option key={mm.model} value={mm.model}>
                            {mm.model}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}

                  {/* Per-arm accuracy + 95% Wilson CI */}
                  <div className="overflow-x-auto rounded-lg border border-zinc-300 bg-white p-3">
                    <div className="mb-2 text-sm font-medium">
                      Accuracy by arm ({agg.model}) — {agg.totalItems} items
                      {agg.errors > 0 && (
                        <span className="text-red-400"> · {agg.errors} errors</span>
                      )}
                    </div>
                    <table className="text-sm">
                      <thead>
                        <tr className="text-zinc-600">
                          <th className="px-2 text-left">arm</th>
                          <th className="px-3">acc</th>
                          <th className="px-3">95% CI</th>
                          <th className="px-3">n</th>
                          <th className="px-3">tok in/out</th>
                          <th className="px-3">latency</th>
                          <th className="px-3">halluc.</th>
                          <th className="px-3">missing</th>
                        </tr>
                      </thead>
                      <tbody>
                        {agg.perArm.map((a) => (
                          <tr key={a.arm} className="border-t border-zinc-200">
                            <td className="px-2 py-1">{a.arm}</td>
                            <td className="px-3 py-1 text-center font-medium">{pct(a.acc)}</td>
                            <td className="px-3 py-1 text-center text-zinc-600">
                              {pct(a.lo)}–{pct(a.hi)}
                            </td>
                            <td className="px-3 py-1 text-center text-zinc-600">{a.n}</td>
                            <td className="px-3 py-1 text-center text-zinc-500">
                              {a.avgInputTokens}/{a.avgOutputTokens}
                            </td>
                            <td className="px-3 py-1 text-center text-zinc-500">
                              {((a.avgLatencyMs ?? 0) / 1000).toFixed(1)}s
                            </td>
                            <td
                              className={`px-3 py-1 text-center ${(a.hallucinationRate ?? 0) > 0 ? "text-red-600" : "text-zinc-500"}`}
                            >
                              {pct(a.hallucinationRate ?? 0)}
                            </td>
                            <td className="px-3 py-1 text-center text-zinc-500">
                              {pct(a.missingInfoRate ?? 0)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="mt-2 text-xs text-zinc-500">
                      Overlapping CIs ⇒ no detectable difference. See McNemar below for paired
                      significance.
                    </div>
                  </div>

                  {/* Accuracy by arm × question category */}
                  <div className="overflow-x-auto rounded-lg border border-zinc-300 bg-white p-3">
                    <div className="mb-2 text-sm font-medium">Accuracy by question category</div>
                    <table className="text-sm">
                      <thead>
                        <tr className="text-zinc-600">
                          <th className="px-2 text-left">arm</th>
                          {CATEGORIES.map((c) => (
                            <th key={c} className="px-3">
                              {c}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {agg.perArm.map((a) => (
                          <tr key={a.arm} className="border-t border-zinc-200">
                            <td className="px-2 py-1">{a.arm}</td>
                            {CATEGORIES.map((c) => {
                              const s = catAcc(a.arm, c);
                              return (
                                <td key={c} className="px-3 py-1 text-center">
                                  {s ? (
                                    <>
                                      {pct(s.acc)}{" "}
                                      <span className="text-zinc-600">({s.n})</span>
                                    </>
                                  ) : (
                                    "·"
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Paired McNemar comparisons */}
                  <div className="overflow-x-auto rounded-lg border border-zinc-300 bg-white p-3">
                    <div className="mb-2 text-sm font-medium">
                      Paired significance (McNemar, p&lt;0.05 = different)
                    </div>
                    <table className="text-sm">
                      <thead>
                        <tr className="text-zinc-600">
                          <th className="px-2 text-left">A vs B</th>
                          <th className="px-3">acc A</th>
                          <th className="px-3">acc B</th>
                          <th className="px-3">only A / only B</th>
                          <th className="px-3">p</th>
                        </tr>
                      </thead>
                      <tbody>
                        {agg.pairwise.map((pw) => {
                          const sig = pw.mcnemar.p < 0.05;
                          return (
                            <tr
                              key={`${pw.armA}-${pw.armB}`}
                              className="border-t border-zinc-200"
                            >
                              <td className="px-2 py-1">
                                {pw.armA} vs {pw.armB}
                              </td>
                              <td className="px-3 py-1 text-center">{pct(pw.accA)}</td>
                              <td className="px-3 py-1 text-center">{pct(pw.accB)}</td>
                              <td className="px-3 py-1 text-center text-zinc-600">
                                {pw.mcnemar.b} / {pw.mcnemar.c}
                              </td>
                              <td
                                className={`px-3 py-1 text-center ${sig ? "font-medium text-emerald-600" : "text-zinc-500"}`}
                              >
                                {pw.mcnemar.p < 0.001 ? "<0.001" : pw.mcnemar.p.toFixed(3)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* Per-question grid — only meaningful for a single scene */}
                  {singleScene && (
                    <div className="overflow-x-auto rounded-lg border border-zinc-300 bg-white p-3">
                      <div className="mb-2 text-sm font-medium">Per-question (this scene)</div>
                      <table className="text-sm">
                        <thead>
                          <tr className="text-zinc-600">
                            <th className="px-2 text-left">question</th>
                            {ARMS.map((a) => (
                              <th key={a} className="px-3">
                                {a}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {QUESTION_IDS.map((q) => (
                            <tr key={q} className="border-t border-zinc-200">
                              <td className="px-2 py-1">{q}</td>
                              {ARMS.map((a) => {
                                const c = cell(a, q);
                                return (
                                  <td key={a} className="px-3 py-1 text-center">
                                    {c ? (c.correct ? "✓" : c.error ? "⚠" : "✗") : "·"}
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })()}

          {/* Representations */}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <RepBox title="A · JSON (baseline)" body={preview.representations.json} />
            <RepBox title="B · ASCII text-twin" body={preview.representations.ascii} mono />
            <RepBox
              title="E · Text map (LLM-optimized)"
              body={preview.representations.textmap}
              mono
            />
            <RepBox title="F · WKT table" body={preview.representations.wkt} mono />
            <RepBox title="D · Verdict ledger" body={preview.representations.verdict} />
            <div className="rounded-lg border border-zinc-300 bg-white p-3">
              <div className="mb-2 text-sm font-medium">C · Map image</div>
              {preview.representations.image ? (
                // biome-ignore lint/performance/noImgElement: data URI preview only
                <img
                  src={preview.representations.image}
                  alt="rendered scene"
                  className="max-h-[400px] rounded border border-zinc-300"
                />
              ) : (
                <div className="text-xs text-zinc-500">
                  {preview.representations.imageNote ?? "no image"}
                </div>
              )}
            </div>
          </div>

          {/* Ground truth */}
          <div className="mt-3 rounded-lg border border-zinc-300 bg-white p-3">
            <div className="mb-2 text-sm font-medium">Ground truth (oracle)</div>
            <pre className="overflow-x-auto text-xs text-zinc-700">
              {JSON.stringify(preview.truths, null, 2)}
            </pre>
          </div>

        </>
      )}
        </>
      )}
    </div>
  );
}

function RepBox({ title, body, mono }: { title: string; body: string; mono?: boolean }) {
  return (
    <div className="rounded-lg border border-zinc-300 bg-white p-3">
      <div className="mb-2 text-sm font-medium">{title}</div>
      <pre
        className={`max-h-[400px] overflow-auto whitespace-pre text-xs text-zinc-700 ${mono ? "leading-[1.1]" : ""}`}
      >
        {body}
      </pre>
    </div>
  );
}
