"use client";

/**
 * Datastore-first workspace: left pane toggles Map | Files (Monaco editor over
 * the virtual DataStore); right pane is the chat. The files are the source of
 * truth — the agent (and you) read/write them via read/glob/grep/write/edit,
 * and the map + text map re-derive from them. A demo of the mechanism; the Eval
 * tab holds the rigorous proof.
 *
 * "text-only" restricts the agent to just textmap.txt, proving the textual
 * representation is load-bearing (no JSON coordinates to route around).
 */

import dynamic from "next/dynamic";
import { useState } from "react";
import { ModelSelect } from "./model-select";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

// Preferred display order for the file tabs (others appended as discovered).
const FILE_ORDER = [
  "README.md",
  "buildings.json",
  "streets.json",
  "layers/equipment.geojson",
  "layers/cables.geojson",
  "basemap.txt",
  "textmap.txt",
  "textmap-v2.txt",
];

// "text-only" keeps the TEXTUAL maps (the canvas + the design) and drops the
// structured JSON/geojson — so the agent must reason from the text, not coords.
const TEXTUAL_FILES = ["basemap.txt", "textmap.txt", "textmap-v2.txt"];

interface ChatStep {
  tool: string;
  input: unknown;
  result: string;
}
interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  steps?: ChatStep[];
  /** Which model produced this reply — recorded at send time. */
  model?: string;
  usage?: { inputTokens: number; outputTokens: number; latencyMs?: number };
}
function stepLabel(s: ChatStep): string {
  const o = (s.input ?? {}) as Record<string, unknown>;
  const arg = o.path ?? o.pattern ?? "";
  return `${s.tool}(${typeof arg === "string" ? arg : ""})`;
}
function langFor(path: string): string {
  if (path.endsWith(".json") || path.endsWith(".geojson")) return "json";
  if (path.endsWith(".md")) return "markdown";
  return "plaintext";
}
function orderedFiles(files: Record<string, string>): string[] {
  const keys = Object.keys(files);
  const known = FILE_ORDER.filter((f) => keys.includes(f));
  const extra = keys.filter((f) => !FILE_ORDER.includes(f)).sort();
  return [...known, ...extra];
}

interface SceneBody {
  source?: "synthetic" | "real";
  city?: string;
  seed?: number;
  plant?: Record<string, boolean | undefined>;
  spec?: Record<string, unknown>;
}

export function WorkspaceTab({
  sceneBody,
  model,
  onModelChange,
  evalSecret,
}: {
  sceneBody: SceneBody;
  model: string;
  /** Lifted to the page — switching remounts the tab (transcript formats can't mix). */
  onModelChange: (id: string) => void;
  /** x-eval-secret for deployed instances with EVAL_SECRET set; empty = open. */
  evalSecret?: string;
}) {
  const secretHeaders: Record<string, string> = evalSecret
    ? { "x-eval-secret": evalSecret }
    : {};
  const [files, setFiles] = useState<Record<string, string> | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>("textmap.txt");
  const [subTab, setSubTab] = useState<"map" | "files">("files");
  const [seeding, setSeeding] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  // What the agent is allowed to read: all files, only the textual maps, or only
  // the structured data (no map). Flip between "text" and "data" to A/B whether
  // the textual representation helps on a given question.
  const [mode, setMode] = useState<"all" | "text" | "data">("all");
  // Full-pipeline mode (default off): the agent runs the real 75.5 machinery —
  // textmap-v2 gains FOOTPRINTS (exact rings) + `feeds=` homing, and a `geo`
  // executor tool computes planar geometry on the coordinates it reads. Off keeps
  // the plain DataStore agent untouched.
  const [pipeline, setPipeline] = useState(false);
  // Whether the self-hosted GeoGlyph SFT endpoint is configured server-side
  // (reported by the seed route). Gates the SFT entry in the model selector.
  const [sftAvailable, setSftAvailable] = useState(false);
  // Full Anthropic transcript (incl. tool blocks) for cross-turn memory; the
  // route returns the updated array and we replay it next turn. `msgs` is just
  // for display.
  const [transcript, setTranscript] = useState<unknown[]>([]);

  const agentFiles = !files
    ? files
    : mode === "text"
      ? Object.fromEntries(TEXTUAL_FILES.filter((f) => f in files).map((f) => [f, files[f]]))
      : mode === "data"
        ? Object.fromEntries(Object.entries(files).filter(([k]) => !TEXTUAL_FILES.includes(k)))
        : files;

  async function loadWorkspace() {
    setSeeding(true);
    setErr(null);
    setMsgs([]);
    setTranscript([]);
    try {
      const r = await fetch("/api/experiments/repr-eval/chat/seed", {
        method: "POST",
        headers: { "content-type": "application/json", ...secretHeaders },
        body: JSON.stringify(sceneBody),
      });
      if (!r.ok) throw new Error(await r.text());
      const data = (await r.json()) as {
        files: Record<string, string>;
        image: string | null;
        sftAvailable?: boolean;
      };
      setFiles(data.files);
      setImage(data.image);
      setSftAvailable(Boolean(data.sftAvailable));
      setSelected(data.files["textmap.txt"] ? "textmap.txt" : orderedFiles(data.files)[0]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSeeding(false);
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || busy || !files) return;
    setMsgs((cur) => [...cur, { role: "user", content: text }]);
    setInput("");
    setBusy(true);
    const nextTranscript = [...transcript, { role: "user", content: text }];
    try {
      const r = await fetch("/api/experiments/repr-eval/chat", {
        method: "POST",
        headers: { "content-type": "application/json", ...secretHeaders },
        body: JSON.stringify({
          files: agentFiles,
          mode,
          pipeline,
          model,
          messages: nextTranscript,
        }),
      });
      if (!r.ok) throw new Error(await r.text());
      const data = (await r.json()) as {
        reply: string;
        steps: ChatStep[];
        files?: Record<string, string>;
        image?: string | null;
        messages?: unknown[];
        usage?: { inputTokens: number; outputTokens: number; latencyMs?: number };
      };
      // Carry the full transcript forward so the agent remembers prior tool calls.
      setTranscript(data.messages ?? [...nextTranscript, { role: "assistant", content: data.reply }]);
      // Merge (don't replace) so a text-only turn never drops the hidden JSON files.
      if (data.files) setFiles((cur) => (cur ? { ...cur, ...data.files } : (data.files ?? cur)));
      if (data.image) setImage(data.image);
      // Follow the agent: open the last file it touched.
      const touched = [...(data.steps ?? [])]
        .reverse()
        .find((s) => ["read", "write", "edit"].includes(s.tool));
      const tp = touched && (touched.input as { path?: string })?.path;
      if (tp) {
        setSelected(tp);
        setSubTab("files");
      }
      setMsgs((cur) => [
        ...cur,
        { role: "assistant", content: data.reply, steps: data.steps, model, usage: data.usage },
      ]);
    } catch (e) {
      setMsgs((cur) => [
        ...cur,
        { role: "assistant", content: `error: ${e instanceof Error ? e.message : String(e)}` },
      ]);
    } finally {
      setBusy(false);
    }
  }

  const tabs = agentFiles ? orderedFiles(agentFiles) : [];

  return (
    <div className="flex h-[72vh] gap-3">
      {/* Left 70%: Map | Files */}
      <div className="flex min-w-0 flex-[7] flex-col rounded-lg border border-zinc-300 bg-white">
        <div className="flex items-center gap-2 border-zinc-200 border-b p-2">
          <button
            type="button"
            onClick={() => setSubTab("map")}
            className={`rounded px-2 py-1 text-sm ${subTab === "map" ? "bg-zinc-200" : "hover:bg-zinc-100"}`}
          >
            Map
          </button>
          <button
            type="button"
            onClick={() => setSubTab("files")}
            className={`rounded px-2 py-1 text-sm ${subTab === "files" ? "bg-zinc-200" : "hover:bg-zinc-100"}`}
          >
            Files
          </button>
          <label
            className="ml-auto flex items-center gap-1 text-xs text-zinc-600"
            title="What the agent may read. Text maps only = no JSON to fall back on (proves it reads the map). Data only = no map (the baseline to beat). Flip between them to A/B whether the text helps."
          >
            agent sees:
            <select
              value={mode}
              onChange={(e) => {
                const m = e.target.value as "all" | "text" | "data";
                setMode(m);
                setSelected(m === "data" ? "buildings.json" : "textmap.txt");
              }}
              className="rounded border border-zinc-300 bg-white px-1 py-0.5"
            >
              <option value="all">all files</option>
              <option value="text">text maps only</option>
              <option value="data">data only (no map)</option>
            </select>
          </label>
          <label
            className="flex items-center gap-1 text-xs text-zinc-600"
            title="Run the real 75.5 pipeline: textmap-v2 gains FOOTPRINTS (exact building rings) + feeds= homing, and the agent gets a geo executor tool for exact planar geometry (crossings, distances, containment). Default off keeps the plain DataStore agent."
          >
            <input
              type="checkbox"
              checked={pipeline}
              onChange={(e) => setPipeline(e.target.checked)}
            />
            full pipeline (rings + executor)
          </label>
          <button
            type="button"
            onClick={loadWorkspace}
            disabled={seeding}
            className="rounded bg-emerald-600 px-3 py-1 text-sm text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {seeding ? "Loading…" : files ? "Reload scene" : "Load scene"}
          </button>
        </div>

        {err && <div className="p-2 text-red-700 text-xs">{err}</div>}

        {!files && !err && (
          <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">
            Click "Load scene" to materialize the DataStore.
          </div>
        )}

        {files && subTab === "files" && (
          <div className="flex min-h-0 flex-1">
            <div className="flex w-44 shrink-0 flex-col gap-0.5 overflow-auto border-zinc-200 border-r p-1">
              <div className="px-2 py-1 text-[10px] text-zinc-500 uppercase tracking-wide">
                DataStore{mode === "text" ? " · text only" : mode === "data" ? " · data only" : ""}
              </div>
              {tabs.map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setSelected(f)}
                  title={f}
                  className={`truncate rounded px-2 py-1 text-left font-mono text-[11px] ${selected === f ? "bg-zinc-200 text-zinc-900" : "text-zinc-600 hover:bg-zinc-100"}`}
                >
                  {f}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1">
              <MonacoEditor
                height="100%"
                theme="vs"
                language={langFor(selected)}
                path={selected}
                value={files[selected] ?? ""}
                onChange={(v) => setFiles((cur) => (cur ? { ...cur, [selected]: v ?? "" } : cur))}
                options={{
                  minimap: { enabled: false },
                  fontSize: 12,
                  wordWrap: "off",
                  scrollBeyondLastLine: false,
                }}
              />
            </div>
          </div>
        )}

        {files && subTab === "map" && (
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-3">
            {image ? (
              // biome-ignore lint/performance/noImgElement: data URI render only
              <img src={image} alt="rendered map" className="max-h-full rounded border border-zinc-300" />
            ) : (
              <div className="text-sm text-zinc-500">no map (missing Mapbox token or empty scene)</div>
            )}
          </div>
        )}
      </div>

      {/* Right 30%: chat */}
      <div className="flex min-w-0 flex-[3] flex-col rounded-lg border border-zinc-300 bg-white">
        <div className="border-zinc-200 border-b p-2 text-sm font-medium">
          AI CHAT
          <div className="font-normal text-[11px] text-zinc-500">
            reads/writes the files via read·glob·grep·write·edit
          </div>
        </div>
        <div className="min-h-0 flex-1 space-y-2 overflow-auto p-2">
          {msgs.length === 0 && (
            <div className="text-[11px] text-zinc-400">
              e.g. "trace B-0 back to the CO" · "is any equipment inside a building?" · "move CL-2
              onto the nearest street"
            </div>
          )}
          {msgs.map((m, i) => (
            <div
              key={`${m.role}-${i}-${m.content.slice(0, 10)}`}
              className={m.role === "user" ? "text-right" : ""}
            >
              {m.steps && m.steps.length > 0 && (
                <div className="mb-1 flex flex-wrap gap-1">
                  {m.steps.map((s, j) => (
                    <span
                      key={`${s.tool}-${j}`}
                      title={s.result}
                      className="rounded border border-zinc-200 bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] text-zinc-600"
                    >
                      {stepLabel(s)}
                    </span>
                  ))}
                </div>
              )}
              <div
                className={`inline-block max-w-full whitespace-pre-wrap rounded px-2 py-1.5 text-left text-sm ${m.role === "user" ? "bg-emerald-100 text-emerald-900" : "bg-zinc-100 text-zinc-800"}`}
              >
                {m.content}
              </div>
              {m.usage && (
                <div
                  className="mt-0.5 font-mono text-[10px] text-zinc-400"
                  title="Whole-turn tokens and wall-clock (system prompt + transcript + files). Illustrative — the eval's single-shot per-arm counts are the clean per-representation measure."
                >
                  {m.model && <span className="text-zinc-500">{m.model} · </span>}
                  {m.usage.inputTokens.toLocaleString()} in · {m.usage.outputTokens.toLocaleString()}{" "}
                  out tokens
                  {m.usage.latencyMs != null && ` · ${(m.usage.latencyMs / 1000).toFixed(1)}s`}
                </div>
              )}
            </div>
          ))}
          {busy && <div className="text-xs text-zinc-500">Jax is working…</div>}
        </div>
        <div className="space-y-1.5 border-zinc-200 border-t p-2">
          {/* Prominent model selector — switch vendors mid-experiment to compare
              (cheap vs frontier). Switching clears the chat (transcript formats). */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-600">model</span>
            <ModelSelect
              value={model}
              onChange={onModelChange}
              size="lg"
              className="flex-1"
              sftAvailable={sftAvailable}
            />
          </div>
          <div className="flex gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") send();
              }}
              disabled={!files}
              aria-label="Ask the datastore agent"
              placeholder={files ? "Ask or instruct…" : "Load a scene first"}
              className="flex-1 rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm disabled:opacity-50"
            />
            <button
              type="button"
              onClick={send}
              disabled={busy || !files}
              className="rounded bg-emerald-600 px-3 py-1.5 text-sm text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
