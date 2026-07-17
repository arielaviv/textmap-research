/**
 * DataStore-first chat: the agent answers (and edits) over a virtual file set
 * through generic primitives — read / glob / grep / write / edit — the same
 * stance as the real Nexma workspace. The DataStore is the source of truth: the
 * client holds the files and sends them each turn; edits return updated files +
 * a re-rendered map image. The oracle-graded /run route remains the proof.
 *
 *   POST /api/experiments/repr-eval/chat
 *   body: { files: Record<string,string>, model?, messages[] }
 *   → { reply, steps, files, image, mutated }
 */

import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { checkEvalAuth } from "@/app/api/experiments/repr-eval/auth";
import { renderImageFromFiles } from "@/app/api/experiments/repr-eval/render-image";
import {
  applyEdit,
  applyWrite,
  filesToScene,
  globMatch,
  grepFiles,
  regenerateDerived,
} from "@/experiments/spatial-repr-eval/core/datastore";
import {
  executeGeoToolLines,
  GEO_TOOLS_SPEC,
} from "@/experiments/spatial-repr-eval/core/geo-tools";
import { routePath } from "@/experiments/spatial-repr-eval/core/route";
import type { Coord, Scene } from "@/experiments/spatial-repr-eval/core/scene";
import { toTextMapV2 } from "@/experiments/spatial-repr-eval/core/textmap";
import { gatewayChat, type OpenAIMessage, type OpenAITool } from "./gateway";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

interface ChatBody {
  files?: Record<string, string>;
  /** Anthropic id ("claude-…") uses the Anthropic SDK; a `provider/model` id
   *  ("openai/gpt-4o", "moonshotai/kimi-k2", …) routes through the AI Gateway. */
  model?: string;
  /** "all" (json+maps) | "text" (textual maps only) | "data" (structured json, no map). */
  mode?: "all" | "text" | "data";
  /** Full-pipeline mode (default off): derive textmap-v2 with rings+feeds
   *  (FOOTPRINTS + homing), expose the geo-tools executor as a `geo` tool, and
   *  append the category-aware scan/extraction guidance — the same machinery the
   *  oracle-graded /run pipeline uses, driven conversationally. */
  pipeline?: boolean;
  /** Full conversation transcript so the agent remembers prior tool calls. Format
   *  matches the chosen model (Anthropic blocks vs OpenAI messages); the client
   *  replays whatever the route returned, and resets it when the model changes. */
  messages?: unknown[];
}

const SYSTEM =
  "You are Jax, a spatial-analysis agent working inside a project DataStore for an FTTH " +
  "(fiber-to-the-home) access network. The DataStore holds files describing ONE small map. " +
  "Before answering, inspect the relevant files with read/glob/grep — do not answer from " +
  "assumptions. You may also edit the design with write/edit. Key files: README.md (index), " +
  "buildings.json, streets.json, layers/equipment.geojson (a central office 'co' plus 'closure's, " +
  "each with a `serves` list), layers/cables.geojson (feeder/distribution/drop cables, " +
  "source -> target). NOTE: basemap.txt (empty geography canvas — use it to find where equipment " +
  "CAN go), textmap.txt (the current design on that canvas + legend) and textmap-v2.txt (the " +
  "same design as TWO ALIGNED LAYERS — geography / network drawn unoccluded, one symbol per " +
  "space-separated cell; cross-reference layers at the same (col,row): equipment over '#' is " +
  "INSIDE that building, a cable glyph over '#' CROSSES it) are READ-ONLY derived " +
  "views — never edit them; edit the structured json/geojson files instead, and the maps + the " +
  "map image re-render automatically. Coordinates are [lng, lat]; use the textmap's GRID REF line " +
  "to convert a grid cell to exact [lng,lat] instead of guessing the scale. When you MOVE equipment, " +
  "also update the matching endpoint of any cable in layers/cables.geojson connected to it, so " +
  "cables stay attached. To LAY a cable (feeder/distribution/drop), ALWAYS use the `route` tool " +
  "with from/to entity ids and kind — it computes the obstacle-avoiding path through open space " +
  "for you; do NOT compute cable waypoints by hand. Answer precisely and cite exact ids " +
  "(e.g. B-0, CL-A, CO-1). Never invent ids.";

const SYSTEM_TEXT_ONLY =
  "You are Jax, a spatial-analysis agent. The DataStore contains ONLY textual maps (no JSON): " +
  "textmap.txt — a north-up ASCII grid ('#'=building, ':'=open margin beside a building (INFERRED " +
  "from footprints, NOT a surveyed sidewalk), '='/'|'=street, '*'=central " +
  "office, lowercase letters=closures, digits/letters=buildings) plus a LEGEND mapping each id to " +
  "its grid cell (col,row), meters from the SW corner, address, nearest street (on=Sn), and " +
  "relationships; textmap-v2.txt — the SAME design as TWO ALIGNED LAYERS (LAYER 1 geography, " +
  "LAYER 2 network drawn unoccluded, one symbol per space-separated cell) — cross-reference " +
  "layers at the same (col,row): an equipment marker over '#' in LAYER 1 sits INSIDE that " +
  "building, a cable glyph over '#' crosses it; and basemap.txt — the same area as an EMPTY " +
  "canvas (geography only, no equipment/cables) for deciding where things CAN go. Read these " +
  "files and answer (or edit) using ONLY them — they are the only data you have. Cite ids " +
  "exactly (e.g. B-0-0, CL-1-2, CO-1); never invent ids.";

const SYSTEM_DATA_ONLY =
  "You are Jax, a spatial-analysis agent. The DataStore contains ONLY structured GeoJSON/JSON " +
  "(buildings.json, streets.json, layers/equipment.geojson with a central office 'co' + 'closure's " +
  "and a `serves` list, layers/cables.geojson with source -> target) — there is NO ASCII/text map. " +
  "Read these files and answer (or edit) using ONLY this structured data. Coordinates are " +
  "[lng, lat]. Cite ids exactly (e.g. B-0-0, CL-1-2, CO-1); never invent ids.";

// Full-pipeline addendum — mirrors core/engine.ts: the category-aware scan
// targets (SCAN_TARGETS.path / SCAN_TARGETS['on-street']), the TOOL_CATEGORIES
// routing (compute-bound relations go through the executor, read-bound ones do
// not), and the geometry-tools round instruction ("read the coordinates, trust
// the computed numbers"). Appended to whichever base prompt the mode selects.
const SYSTEM_PIPELINE_SUFFIX =
  "\n\nFULL-PIPELINE MODE. textmap-v2.txt now carries a FOOTPRINTS section (each building's EXACT " +
  "outline vertices in meters, x/y from the SW corner) and the CO's `feeds=` homing list — use " +
  "these exact numbers, never estimate rings from grid cells. Answer in three steps:\n" +
  "(1) SCAN — before answering, extract the facts the question consumes. For path / topology / " +
  "connectivity questions extract the CONNECTIVITY GRAPH only: each equipment's exact id, its " +
  "kind/role, and its full serves list (include roots that serve nothing); each cable's id and its " +
  "source -> target — do NOT use positions or distances. For on-street / placement questions " +
  "extract each equipment's id with its d_street / on= / coordinates and NOT serves lists. " +
  "Otherwise extract every id the question could involve with its exact measurements.\n" +
  "(2) COMPUTE — for any geometric relation (distances, containment, a cable/segment crossing a " +
  "building, line-intersection, midpoints, hulls) call the `geo` tool: read the exact meter " +
  "coordinates out of FOOTPRINTS / the legend, emit one JSON op per line, and TRUST the returned " +
  "numbers over mental arithmetic (the executor computes exactly what you supply). Connectivity / " +
  "path questions are answered from the legend, not geometry — do not call `geo` for those.\n" +
  "(3) ANSWER precisely, citing exact ids.";

const TOOLS: Anthropic.Tool[] = [
  {
    name: "read",
    description: "Read a whole file from the DataStore by exact path.",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "glob",
    description: "List DataStore files matching a glob pattern, e.g. 'layers/*' or '**'.",
    input_schema: {
      type: "object",
      properties: { pattern: { type: "string" } },
      required: ["pattern"],
    },
  },
  {
    name: "grep",
    description: "Search file contents by regex. Optional 'path' limits to one file.",
    input_schema: {
      type: "object",
      properties: { pattern: { type: "string" }, path: { type: "string" } },
      required: ["pattern"],
    },
  },
  {
    name: "write",
    description: "Create or overwrite a structured file with new content (must stay valid JSON).",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "edit",
    description:
      "Replace a unique snippet in a file. Fails if old_string is missing or not unique.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "route",
    description:
      "Lay a cable between two entities with an obstacle-avoiding path: it computes the exact " +
      "route through open space, AVOIDING real building footprints, crossing streets only " +
      "when necessary, and writes it to layers/cables.geojson. ALWAYS use this for cables instead " +
      "of computing waypoints by hand. `from`/`to` are entity ids (e.g. CO-1, CAB-1, CL-A, B-0).",
    input_schema: {
      type: "object",
      properties: {
        from: { type: "string" },
        to: { type: "string" },
        kind: { type: "string", description: "feeder | distribution | drop" },
        id: { type: "string", description: "optional cable id" },
      },
      required: ["from", "to"],
    },
  },
];

/** The geometry executor as a single agent tool (pipeline mode only). Reuses
 *  GEO_TOOLS_SPEC + executeGeoToolLines from core/geo-tools.ts: the model reads
 *  coordinates out of the representation and emits JSON op lines; the handler
 *  runs pure planar math on exactly those numbers (it never sees the scene) and
 *  feeds the results back — a real two-call executor. */
const GEO_TOOL: Anthropic.Tool = {
  name: "geo",
  description:
    "Run exact planar geometry on coordinates YOU read from the representation. The executor never " +
    "sees the scene, so a misread coordinate yields an honestly-computed wrong number — quote exact " +
    "meters from FOOTPRINTS / the legend. Put one JSON op per line in `lines`.\n" +
    GEO_TOOLS_SPEC,
  input_schema: {
    type: "object",
    properties: {
      lines: {
        type: "string",
        description: "one JSON geometry op per line, exactly as the spec shows (no prose)",
      },
    },
    required: ["lines"],
  },
};

const toOpenAITool = (t: Anthropic.Tool): OpenAITool => ({
  type: "function",
  function: {
    name: t.name,
    description: typeof t.description === "string" ? t.description : "",
    parameters: t.input_schema as Record<string, unknown>,
  },
});

/** Same six tools in OpenAI function format, for gateway models. */
const OPENAI_TOOLS: OpenAITool[] = TOOLS.map(toOpenAITool);
const GEO_TOOL_OPENAI: OpenAITool = toOpenAITool(GEO_TOOL);

/** Tool sets by mode: pipeline adds the `geo` executor to the six primitives. */
const anthropicTools = (pipeline: boolean): Anthropic.Tool[] =>
  pipeline ? [...TOOLS, GEO_TOOL] : TOOLS;
const openaiTools = (pipeline: boolean): OpenAITool[] =>
  pipeline ? [...OPENAI_TOOLS, GEO_TOOL_OPENAI] : OPENAI_TOOLS;

/** In pipeline mode, re-derive textmap-v2.txt with FOOTPRINTS (exact rings) +
 *  `feeds=` homing from the structured files, so the geo executor has exact
 *  inputs. Only touches an existing textmap-v2.txt (a no-op in data-only mode,
 *  which carries no text map). Derived from the files so it survives edits. */
function enrichPipelineViews(files: Record<string, string>): Record<string, string> {
  if (files["textmap-v2.txt"] === undefined) return files;
  const scene = filesToScene(files);
  if (!scene) return files;
  return { ...files, "textmap-v2.txt": toTextMapV2(scene, { rings: true, feeds: true }) };
}

/** Resolve an entity id to its [lng,lat] (equipment point or building centroid). */
function resolveEntity(scene: Scene, id: string): Coord | null {
  const e = scene.equipment.find((x) => x.id === id);
  if (e) return e.position;
  const b = scene.buildings.find((x) => x.id === id);
  if (b) return b.centroid;
  return null;
}

/** Compute an obstacle-avoiding path between two entities and append it as a cable. */
function routeCable(
  files: Record<string, string>,
  from: string,
  to: string,
  kind: string,
  id: string,
): { files: Record<string, string>; ok: boolean; message: string } {
  const scene = filesToScene(files);
  if (!scene) return { files, ok: false, message: "Error: could not parse the scene." };
  const fromPos = resolveEntity(scene, from);
  if (!fromPos) return { files, ok: false, message: `Error: unknown entity "${from}".` };
  const toPos = resolveEntity(scene, to);
  if (!toPos) return { files, ok: false, message: `Error: unknown entity "${to}".` };
  const path = routePath(scene, fromPos, toPos);
  if (!path) {
    return { files, ok: false, message: `No clear route from ${from} to ${to} (fully blocked).` };
  }
  const cableKind = ["feeder", "distribution", "drop"].includes(kind) ? kind : "distribution";
  const cableId = id || `${cableKind}-${from}-${to}`;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(files["layers/cables.geojson"] ?? "");
  } catch {
    parsed = null;
  }
  const fc = asObj(parsed);
  const features = Array.isArray(fc.features) ? [...(fc.features as unknown[])] : [];
  features.push({
    type: "Feature",
    id: cableId,
    geometry: { type: "LineString", coordinates: path },
    properties: { kind: cableKind, source: from, target: to },
  });
  return {
    files: {
      ...files,
      "layers/cables.geojson": JSON.stringify({ type: "FeatureCollection", features }, null, 2),
    },
    ok: true,
    message: `routed ${from} -> ${to} as a ${cableKind} cable "${cableId}" with ${path.length} waypoints, around all buildings.`,
  };
}

const asStr = (v: unknown): string => (typeof v === "string" ? v : "");
const asObj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};

// ── GeoGlyph SFT v1 (self-hosted HF TGI, env-gated) ────────────────────────
// The fine-tune is a single-shot answerer (it emits "EXTRACTION: … ANSWER:
// {json}"), not a tool-using agent — so this path is one /generate call with the
// Llama-3.1 chat template, ported from experiments/spatial-repr-eval/sft-eval.mjs
// (llamaPrompt + askTgi). Faithful to training: same SYSTEM, same "QUESTION:\n"
// layout, the textmap-v2 representation it was trained on.
const SFT_SYSTEM =
  "You are a precise spatial-analysis assistant for GIS / FTTH network data. " +
  "You are given a representation of a small map (buildings, streets, equipment, cables) and ONE question. " +
  "First write an EXTRACTION: section listing the facts relevant to the question, exactly as they appear in the representation. " +
  "Then output your final line as: ANSWER: {json object with ONLY the requested field(s)}. " +
  "Ids must match exactly the ids present in the data. Do not invent ids.";

function llamaPrompt(user: string): string {
  return (
    `<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\n${SFT_SYSTEM}<|eot_id|>` +
    `<|start_header_id|>user<|end_header_id|>\n\n${user}<|eot_id|>` +
    `<|start_header_id|>assistant<|end_header_id|>\n\n`
  );
}

/** One TGI `/generate` call (Llama-3.1 template). Deterministic, no streaming —
 *  the same fetch shape sft-eval.mjs uses against an HF Inference Endpoint. */
async function askTgi(
  baseUrl: string,
  token: string,
  user: string,
): Promise<{ text: string; error?: string }> {
  const r = await fetch(`${baseUrl.replace(/\/$/, "")}/generate`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      inputs: llamaPrompt(user),
      parameters: { max_new_tokens: 1500, do_sample: false, return_full_text: false },
    }),
  });
  if (!r.ok) return { text: "", error: `${r.status}: ${(await r.text()).slice(0, 200)}` };
  const data: unknown = await r.json();
  const text = Array.isArray(data)
    ? asStr(asObj(data[0]).generated_text)
    : asStr(asObj(data).generated_text);
  return { text };
}

/** The single representation the SFT model was trained on: textmap-v2 (its home
 *  representation), or the JSON blocks when the agent is in data-only mode. */
function sftRepresentation(files: Record<string, string>, mode: string): string {
  if (mode !== "data") {
    const tm = files["textmap-v2.txt"] ?? files["textmap.txt"];
    if (tm) return tm;
  }
  return ["buildings.json", "streets.json", "layers/equipment.geojson", "layers/cables.geojson"]
    .filter((p) => files[p] !== undefined)
    .map((p) => `=== ${p} ===\n${files[p]}`)
    .join("\n");
}

/** Last user message text from either transcript format (both send a string). */
function lastUserText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = asObj(messages[i]);
    if (m.role === "user" && typeof m.content === "string") return m.content;
  }
  return "";
}

function execRead(name: string, input: unknown, files: Record<string, string>): string {
  const o = asObj(input);
  if (name === "read") {
    const path = asStr(o.path);
    return files[path] ?? `Error: no such file "${path}". Available: ${Object.keys(files).join(", ")}`;
  }
  if (name === "glob") {
    const m = globMatch(asStr(o.pattern), Object.keys(files));
    return m.length ? m.join("\n") : "(no matches)";
  }
  if (name === "grep") {
    const path = o.path ? asStr(o.path) : undefined;
    const m = grepFiles(asStr(o.pattern), files, path);
    return m.length ? m.slice(0, 60).join("\n") : "(no matches)";
  }
  return `unknown tool: ${name}`;
}

/** Re-derive views after a mutation; in pipeline mode keep textmap-v2's rings. */
function deriveAfterMutation(
  files: Record<string, string>,
  pipeline: boolean,
): Record<string, string> {
  const derived = regenerateDerived(files);
  return pipeline ? enrichPipelineViews(derived) : derived;
}

/** Run one tool call (read/glob/grep/write/edit/route, plus geo in pipeline
 *  mode), shared by the Anthropic and gateway loops. write/edit/route mutate the
 *  files + re-derive the views; geo runs the pure-math executor (read-only). */
function executeTool(
  name: string,
  input: unknown,
  files: Record<string, string>,
  pipeline = false,
): { out: string; files: Record<string, string>; mutated: boolean } {
  const o = asObj(input);
  if (name === "geo") {
    const out =
      executeGeoToolLines(asStr(o.lines)) ??
      "(no valid tool lines — emit one JSON op per line, no prose, per the spec)";
    return { out, files, mutated: false };
  }
  if (name === "write" || name === "edit") {
    const w =
      name === "write"
        ? applyWrite(files, asStr(o.path), asStr(o.content))
        : applyEdit(files, asStr(o.path), asStr(o.old_string), asStr(o.new_string));
    // Re-derive the views NOW so a later read in this same turn sees the change.
    return w.ok
      ? { out: w.message, files: deriveAfterMutation(w.files, pipeline), mutated: true }
      : { out: w.message, files: w.files, mutated: false };
  }
  if (name === "route") {
    const r = routeCable(files, asStr(o.from), asStr(o.to), asStr(o.kind), asStr(o.id));
    return r.ok
      ? { out: r.message, files: deriveAfterMutation(r.files, pipeline), mutated: true }
      : { out: r.message, files: r.files, mutated: false };
  }
  return { out: execRead(name, input, files), files, mutated: false };
}

interface LoopResult {
  reply: string;
  steps: { tool: string; input: unknown; result: string }[];
  files: Record<string, string>;
  mutated: boolean;
  messages: unknown[];
  inputTokens: number;
  outputTokens: number;
}

/** Agent loop for gateway models (OpenAI chat-completions format). System prompt
 *  is prepended per call and NOT stored in the returned transcript. */
async function runGatewayLoop(
  model: string,
  systemPrompt: string,
  convo: OpenAIMessage[],
  files0: Record<string, string>,
  pipeline: boolean,
): Promise<LoopResult> {
  let files = files0;
  let mutated = false;
  let reply = "";
  let inputTokens = 0;
  let outputTokens = 0;
  const steps: LoopResult["steps"] = [];
  const tools = openaiTools(pipeline);
  for (let iter = 0; iter < 16; iter++) {
    const apiMessages: OpenAIMessage[] = [{ role: "system", content: systemPrompt }, ...convo];
    const r = await gatewayChat(model, apiMessages, tools);
    inputTokens += r.usage.promptTokens;
    outputTokens += r.usage.completionTokens;
    if (r.toolCalls.length === 0) {
      reply = r.content;
      convo.push({ role: "assistant", content: r.content });
      break;
    }
    convo.push({ role: "assistant", content: r.content || null, tool_calls: r.toolCalls });
    for (const tc of r.toolCalls) {
      let input: unknown = {};
      try {
        input = JSON.parse(tc.function.arguments || "{}");
      } catch {
        input = {};
      }
      const ex = executeTool(tc.function.name, input, files, pipeline);
      files = ex.files;
      if (ex.mutated) mutated = true;
      steps.push({ tool: tc.function.name, input, result: ex.out.slice(0, 500) });
      convo.push({ role: "tool", tool_call_id: tc.id, content: ex.out });
    }
    if (iter === 15) reply = r.content || "(stopped after 16 tool steps)";
  }
  return { reply, steps, files, mutated, messages: convo, inputTokens, outputTokens };
}

export async function POST(req: Request) {
  const denied = checkEvalAuth(req);
  if (denied) return denied;
  const t0 = Date.now(); // whole-turn wall clock, consistent with whole-turn tokens
  let body: ChatBody;
  try {
    body = (await req.json()) as ChatBody;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const seedFiles = body.files;
  if (!seedFiles || Object.keys(seedFiles).length === 0) {
    return NextResponse.json({ error: "no files — seed the workspace first" }, { status: 400 });
  }
  const files0: Record<string, string> = seedFiles;
  // The client sends the FULL transcript (in the chosen model's format) so the
  // agent remembers prior tool calls; it resets when the model changes.
  const rawMessages = body.messages ?? [];
  if (rawMessages.length === 0) return NextResponse.json({ error: "no messages" }, { status: 400 });

  const model = body.model || "claude-sonnet-4-6";
  const mode = body.mode ?? "all";
  const pipeline = body.pipeline === true;

  // ── GeoGlyph SFT v1 (self-hosted HF TGI, env-gated) ──────────────────────
  // Single-shot: one /generate call with the trained representation + question.
  // Env-gated so nothing hits HF (and nothing is spun up) unless BOTH vars are
  // set — otherwise a clear "not configured" message and no network call.
  if (model === "geoglyph-8b-v1") {
    const sftUrl = process.env.HF_SFT_URL;
    const hfToken = process.env.HF_TOKEN;
    if (!sftUrl || !hfToken) {
      return NextResponse.json(
        { error: "SFT endpoint not configured (set HF_SFT_URL + HF_TOKEN)" },
        { status: 503 },
      );
    }
    const userText = lastUserText(rawMessages);
    const user = `${sftRepresentation(files0, mode)}\n\nQUESTION:\n${userText}`;
    const sft = await askTgi(sftUrl, hfToken, user);
    if (sft.error) {
      return NextResponse.json({ error: `SFT endpoint error ${sft.error}` }, { status: 502 });
    }
    const image = await renderImageFromFiles(files0);
    return NextResponse.json({
      reply: sft.text || "(no output)",
      steps: [],
      files: files0,
      image,
      mutated: false,
      messages: [...rawMessages, { role: "assistant", content: sft.text }],
      usage: { inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - t0 },
    });
  }

  const baseSystem =
    mode === "text" ? SYSTEM_TEXT_ONLY : mode === "data" ? SYSTEM_DATA_ONLY : SYSTEM;
  const systemPrompt = pipeline ? baseSystem + SYSTEM_PIPELINE_SUFFIX : baseSystem;
  // Pipeline mode: enrich textmap-v2 with FOOTPRINTS (rings) + `feeds=` homing so
  // the geo executor has exact inputs. Off by default → files pass through.
  const startFiles = pipeline ? enrichPipelineViews(files0) : files0;

  // ── Gateway models (provider/model, e.g. openai/gpt-4o) ──────────────────
  if (model.includes("/")) {
    try {
      const g = await runGatewayLoop(
        model,
        systemPrompt,
        rawMessages as OpenAIMessage[],
        startFiles,
        pipeline,
      );
      const image = await renderImageFromFiles(g.files);
      return NextResponse.json({
        reply: g.reply,
        steps: g.steps,
        files: g.files,
        image,
        mutated: g.mutated,
        messages: g.messages,
        usage: {
          inputTokens: g.inputTokens,
          outputTokens: g.outputTokens,
          latencyMs: Date.now() - t0,
        },
      });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "gateway error" },
        { status: 500 },
      );
    }
  }

  // ── Anthropic models (claude-*) ──────────────────────────────────────────
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "ANTHROPIC_API_KEY not set" }, { status: 500 });
  let files: Record<string, string> = startFiles;
  const messages = rawMessages as Anthropic.MessageParam[];
  const client = new Anthropic({ apiKey });
  const tools = anthropicTools(pipeline);

  const steps: { tool: string; input: unknown; result: string }[] = [];
  let reply = "";
  let mutated = false;
  // Token accounting across the whole turn — lets the workspace surface the
  // representation's cost (data-only JSON vs textmap). NOTE: includes the system
  // prompt + transcript, so it's illustrative; the eval's single-shot per-arm
  // token counts are the clean per-representation measure.
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    for (let iter = 0; iter < 16; iter++) {
      const resp = await client.messages.create({
        model,
        max_tokens: 8000,
        system: systemPrompt,
        tools,
        messages,
      });
      inputTokens += resp.usage.input_tokens;
      outputTokens += resp.usage.output_tokens;
      let text = "";
      const toolUses: { id: string; name: string; input: unknown }[] = [];
      for (const b of resp.content) {
        if (b.type === "text") text += b.text;
        else if (b.type === "tool_use") toolUses.push({ id: b.id, name: b.name, input: b.input });
      }

      if (toolUses.length === 0) {
        reply = text;
        // Keep the final assistant turn in the transcript so the next turn
        // remembers it (full session memory).
        messages.push({ role: "assistant", content: resp.content as Anthropic.ContentBlockParam[] });
        break;
      }

      messages.push({ role: "assistant", content: resp.content as Anthropic.ContentBlockParam[] });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        const ex = executeTool(tu.name, tu.input, files, pipeline);
        files = ex.files;
        if (ex.mutated) mutated = true;
        steps.push({ tool: tu.name, input: tu.input, result: ex.out.slice(0, 500) });
        results.push({ type: "tool_result", tool_use_id: tu.id, content: ex.out });
      }
      messages.push({ role: "user", content: results });
      if (iter === 15) reply = text || "(stopped after 16 tool steps)";
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "model error" },
      { status: 500 },
    );
  }

  // Always re-render so the map reflects the current files every turn (not only
  // after an edit) — otherwise a fixed render bug or a stale map can't recover
  // without mutating. Renders from the full file set regardless of agent mode.
  const image: string | null = await renderImageFromFiles(files);

  return NextResponse.json({
    reply,
    steps,
    files,
    image,
    mutated,
    messages,
    usage: { inputTokens, outputTokens, latencyMs: Date.now() - t0 },
  });
}
