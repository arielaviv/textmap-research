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
import { renderImageFromFiles } from "@/app/api/experiments/repr-eval/render-image";
import {
  applyEdit,
  applyWrite,
  filesToScene,
  globMatch,
  grepFiles,
  regenerateDerived,
} from "@/experiments/spatial-repr-eval/core/datastore";
import { routePath } from "@/experiments/spatial-repr-eval/core/route";
import type { Coord, Scene } from "@/experiments/spatial-repr-eval/core/scene";
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
  "CAN go) and textmap.txt (the current design on that canvas + legend) are READ-ONLY derived " +
  "views — never edit them; edit the structured json/geojson files instead, and both maps + the " +
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
  "relationships; and basemap.txt — the same area as an EMPTY canvas (geography only, no " +
  "equipment/cables) for deciding where things CAN go. Read these files and answer (or edit) " +
  "using ONLY them — they are the only data you have. Cite ids exactly (e.g. B-0-0, CL-1-2, " +
  "CO-1); never invent ids.";

const SYSTEM_DATA_ONLY =
  "You are Jax, a spatial-analysis agent. The DataStore contains ONLY structured GeoJSON/JSON " +
  "(buildings.json, streets.json, layers/equipment.geojson with a central office 'co' + 'closure's " +
  "and a `serves` list, layers/cables.geojson with source -> target) — there is NO ASCII/text map. " +
  "Read these files and answer (or edit) using ONLY this structured data. Coordinates are " +
  "[lng, lat]. Cite ids exactly (e.g. B-0-0, CL-1-2, CO-1); never invent ids.";

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

/** Same six tools in OpenAI function format, for gateway models. */
const OPENAI_TOOLS: OpenAITool[] = TOOLS.map((t) => ({
  type: "function",
  function: {
    name: t.name,
    description: typeof t.description === "string" ? t.description : "",
    parameters: t.input_schema as Record<string, unknown>,
  },
}));

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

/** Run one tool call (read/glob/grep/write/edit/route), shared by the Anthropic
 *  and gateway loops. write/edit/route mutate the files + re-derive the views. */
function executeTool(
  name: string,
  input: unknown,
  files: Record<string, string>,
): { out: string; files: Record<string, string>; mutated: boolean } {
  const o = asObj(input);
  if (name === "write" || name === "edit") {
    const w =
      name === "write"
        ? applyWrite(files, asStr(o.path), asStr(o.content))
        : applyEdit(files, asStr(o.path), asStr(o.old_string), asStr(o.new_string));
    // Re-derive the views NOW so a later read in this same turn sees the change.
    return w.ok
      ? { out: w.message, files: regenerateDerived(w.files), mutated: true }
      : { out: w.message, files: w.files, mutated: false };
  }
  if (name === "route") {
    const r = routeCable(files, asStr(o.from), asStr(o.to), asStr(o.kind), asStr(o.id));
    return r.ok
      ? { out: r.message, files: regenerateDerived(r.files), mutated: true }
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
): Promise<LoopResult> {
  let files = files0;
  let mutated = false;
  let reply = "";
  let inputTokens = 0;
  let outputTokens = 0;
  const steps: LoopResult["steps"] = [];
  for (let iter = 0; iter < 16; iter++) {
    const apiMessages: OpenAIMessage[] = [{ role: "system", content: systemPrompt }, ...convo];
    const r = await gatewayChat(model, apiMessages, OPENAI_TOOLS);
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
      const ex = executeTool(tc.function.name, input, files);
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
  const systemPrompt =
    body.mode === "text" ? SYSTEM_TEXT_ONLY : body.mode === "data" ? SYSTEM_DATA_ONLY : SYSTEM;

  // ── Gateway models (provider/model, e.g. openai/gpt-4o) ──────────────────
  if (model.includes("/")) {
    try {
      const g = await runGatewayLoop(model, systemPrompt, rawMessages as OpenAIMessage[], files0);
      const image = await renderImageFromFiles(g.files);
      return NextResponse.json({
        reply: g.reply,
        steps: g.steps,
        files: g.files,
        image,
        mutated: g.mutated,
        messages: g.messages,
        usage: { inputTokens: g.inputTokens, outputTokens: g.outputTokens },
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
  let files: Record<string, string> = files0;
  const messages = rawMessages as Anthropic.MessageParam[];
  const client = new Anthropic({ apiKey });

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
        tools: TOOLS,
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
        const ex = executeTool(tu.name, tu.input, files);
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
    usage: { inputTokens, outputTokens },
  });
}
