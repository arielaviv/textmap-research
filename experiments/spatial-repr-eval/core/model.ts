/**
 * Model client for the eval. Sends one representation + one question and forces
 * a structured answer (the `submit_answer` schema) so grading is deterministic.
 * Routes by the registry: Anthropic ids → Anthropic SDK; `provider/model` ids →
 * the Vercel AI Gateway (OpenAI-compatible). The image arm attaches the PNG as a
 * vision input; the engine only sends it to vision-capable models.
 */

import Anthropic from "@anthropic-ai/sdk";
import { modelInfo } from "./models";
import { ANSWER_TOOL_SCHEMA, type Answer } from "./questions";

export interface AskInput {
  apiKey: string;
  model: string;
  temperature: number;
  representation: { text: string; image?: { base64: string; mediaType: "image/png" } };
  question: string;
  /** Free-text mode: no forced tool — used by the scan phase (fact extraction).
   *  The reply lands in `rawText`; `answer` stays null. */
  freeText?: boolean;
  /** Explicit output budget for THIS call only — the tools round needs more
   *  than the scan default (ring marshaling truncated at 1500, probe 3)
   *  without touching scan/answer budgets anywhere else. */
  maxTokensOverride?: number;
}

export interface AskResult {
  answer: Answer | null;
  /** Plain-text reply when freeText was requested. */
  rawText?: string;
  inputTokens: number;
  outputTokens: number;
  /** Wall-clock time of the provider call (including network), ms. */
  latencyMs: number;
  error?: string;
}

const SYSTEM =
  "You are a precise spatial-analysis assistant for GIS / FTTH network data. " +
  "You are given a representation of a small map (buildings, streets, equipment, cables) and ONE question. " +
  "Reason carefully about the spatial relationships, then call submit_answer with ONLY the requested field(s). " +
  "Ids must match exactly the ids present in the data. Do not invent ids. " +
  "If (and only if) the representation truly lacks the information needed to answer, also fill " +
  "`missingInfo` with a brief note of what is missing.";

const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/chat/completions";

/** Models occasionally return a lone string where the schema says array (seen
 *  with the citations condition). Coerce field types so graders never crash. */
function coerceAnswer(raw: unknown): Answer {
  const a = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const arr = (v: unknown): string[] | undefined =>
    v == null
      ? undefined
      : Array.isArray(v)
        ? v.map(String)
        : typeof v === "string"
          ? [v]
          : undefined;
  const str = (v: unknown): string | undefined =>
    typeof v === "string" ? v : v == null ? undefined : String(v);
  return {
    equipmentIds: arr(a.equipmentIds),
    cableIds: arr(a.cableIds),
    buildingIds: arr(a.buildingIds),
    equipmentPath: arr(a.equipmentPath),
    evidence: arr(a.evidence),
    closureId: str(a.closureId),
    onStreet: typeof a.onStreet === "boolean" ? a.onStreet : undefined,
    count: typeof a.count === "number" ? a.count : a.count != null ? Number(a.count) : undefined,
    direction: str(a.direction),
    quadrant: str(a.quadrant),
    missingInfo: str(a.missingInfo),
  };
}

export async function askModel(input: AskInput): Promise<AskResult> {
  // "together:<model-id>" routes to Together AI (SFT checkpoints + their base
  // models). No registry entry needed — the prefix IS the routing.
  if (input.model.startsWith("together:")) return askTogether(input);
  return modelInfo(input.model).provider === "gateway" ? askGateway(input) : askAnthropic(input);
}

async function askAnthropic(input: AskInput): Promise<AskResult> {
  const client = new Anthropic({ apiKey: input.apiKey });
  const info = modelInfo(input.model);

  const content: Anthropic.ContentBlockParam[] = [
    { type: "text", text: `MAP REPRESENTATION:\n${input.representation.text}` },
  ];
  if (input.representation.image) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: input.representation.image.mediaType,
        data: input.representation.image.base64,
      },
    });
  }
  content.push({ type: "text", text: `QUESTION:\n${input.question}` });

  const t0 = Date.now();
  try {
    const resp = await client.messages.create({
      model: input.model,
      // Always-thinking models (Fable 5) spend thinking tokens inside max_tokens;
      // 1024 would truncate before the tool call. Scan (freeText) calls get
      // their own budget — reasoning models need far more than 1500 there,
      // while answer-call budgets stay fixed for baseline pairing.
      max_tokens:
        input.maxTokensOverride ??
        (input.freeText
          ? (info.scanMaxTokens ?? Math.max(1500, info.maxTokens ?? 0))
          : (info.maxTokens ?? 1024)),
      // Opus 4.7+/Fable 5 reject sampling params with a 400 — omit temperature.
      ...(info.acceptsTemperature !== false ? { temperature: input.temperature } : {}),
      system: info.alwaysThinking
        ? `${SYSTEM} You MUST call submit_answer exactly once with your final answer.`
        : SYSTEM,
      ...(input.freeText
        ? {}
        : {
            tools: [
              {
                name: "submit_answer",
                description: "Submit the structured answer to the question.",
                input_schema: ANSWER_TOOL_SCHEMA as unknown as Anthropic.Tool["input_schema"],
              },
            ],
            // Forced tool_choice conflicts with thinking; on always-thinking models fall
            // back to auto + the MUST-call instruction (a null answer grades as error).
            ...(info.alwaysThinking
              ? {}
              : { tool_choice: { type: "tool" as const, name: "submit_answer" } }),
          }),
      messages: [{ role: "user", content }],
    });

    let answer: Answer | null = null;
    let rawText: string | undefined;
    for (const block of resp.content) {
      if (block.type === "tool_use" && block.name === "submit_answer") {
        answer = coerceAnswer(block.input);
        break;
      }
      if (block.type === "text" && input.freeText) rawText = (rawText ?? "") + block.text;
    }
    return {
      answer,
      rawText,
      inputTokens: resp.usage.input_tokens,
      outputTokens: resp.usage.output_tokens,
      latencyMs: Date.now() - t0,
    };
  } catch (err) {
    return {
      answer: null,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

interface GatewayResponse {
  choices?: {
    message?: {
      content?: string;
      tool_calls?: { function?: { name?: string; arguments?: string } }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Extract the LAST JSON object from free text (fenced or bare). SFT models
 *  answer with a trailing "ANSWER: {...}" line instead of a tool call. */
function lastJsonObject(text: string): Record<string, unknown> | null {
  const matches = text.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g);
  if (!matches) return null;
  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(matches[i]) as unknown;
      if (typeof obj === "object" && obj !== null) return obj as Record<string, unknown>;
    } catch {
      // keep scanning backwards
    }
  }
  return null;
}

const TOGETHER_URL = "https://api.together.xyz/v1/chat/completions";
const TOGETHER_SYSTEM =
  "You are a precise spatial-analysis assistant for GIS / FTTH network data. " +
  "You are given a representation of a small map (buildings, streets, equipment, cables) and ONE question. " +
  "First write an EXTRACTION: section listing the facts relevant to the question, exactly as they appear in the representation. " +
  "Then output your final line as: ANSWER: {json object with ONLY the requested field(s)}. " +
  "Ids must match exactly the ids present in the data. Do not invent ids.";

/** Together AI path — OpenAI-compatible, NO tool calling: the SFT checkpoint
 *  (and its base-model control) answers in the trained trailing-JSON format,
 *  parsed with lastJsonObject + coerceAnswer. Vision unsupported (text only). */
async function askTogether(input: AskInput): Promise<AskResult> {
  const key = process.env.TOGETHER_API_KEY;
  if (!key) {
    return {
      answer: null,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      error: "TOGETHER_API_KEY not set — export it (see docs/sft-launch.md).",
    };
  }
  const model = input.model.slice("together:".length);
  const t0 = Date.now();
  try {
    const res = await fetch(TOGETHER_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: input.temperature,
        // Trace + answer needs headroom; freeText (scan) reuses the same cap.
        max_tokens: input.maxTokensOverride ?? 2000,
        messages: [
          { role: "system", content: TOGETHER_SYSTEM },
          {
            role: "user",
            content: `MAP REPRESENTATION:\n${input.representation.text}\n\nQUESTION:\n${input.question}`,
          },
        ],
        stream: false,
      }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return {
        answer: null,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: Date.now() - t0,
        error: `together ${model} ${res.status}: ${txt.slice(0, 200)}`,
      };
    }
    const data = (await res.json()) as GatewayResponse;
    const content = data.choices?.[0]?.message?.content ?? "";
    const parsed = input.freeText ? null : lastJsonObject(content);
    return {
      answer: parsed ? coerceAnswer(parsed) : null,
      rawText: input.freeText ? content : undefined,
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      latencyMs: Date.now() - t0,
      ...(parsed || input.freeText ? {} : { error: "no JSON object found in reply" }),
    };
  } catch (err) {
    return {
      answer: null,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function askGateway(input: AskInput): Promise<AskResult> {
  const key = process.env.AI_GATEWAY_API_KEY;
  if (!key) {
    return {
      answer: null,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      error: "AI_GATEWAY_API_KEY not set — add it (with billing) in Vercel to run gateway models.",
    };
  }

  // OpenAI-format user content: text + optional vision image part.
  const userContent: Array<Record<string, unknown>> = [
    { type: "text", text: `MAP REPRESENTATION:\n${input.representation.text}` },
  ];
  if (input.representation.image) {
    userContent.push({
      type: "image_url",
      image_url: { url: `data:${input.representation.image.mediaType};base64,${input.representation.image.base64}` },
    });
  }
  userContent.push({ type: "text", text: `QUESTION:\n${input.question}` });

  const info = modelInfo(input.model);
  const t0 = Date.now();
  try {
    const res = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: input.model,
        ...(info.acceptsTemperature !== false ? { temperature: input.temperature } : {}),
        // Scan (freeText) budget is separate — see the Anthropic path's note.
        max_tokens:
          input.maxTokensOverride ??
          (input.freeText
            ? (info.scanMaxTokens ?? Math.max(1500, info.maxTokens ?? 0))
            : (info.maxTokens ?? 1024)),
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: userContent },
        ],
        ...(input.freeText
          ? {}
          : {
              tools: [
                {
                  type: "function",
                  function: {
                    name: "submit_answer",
                    description: "Submit the structured answer to the question.",
                    parameters: ANSWER_TOOL_SCHEMA as unknown as Record<string, unknown>,
                  },
                },
              ],
              tool_choice: { type: "function", function: { name: "submit_answer" } },
            }),
        stream: false,
      }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return {
        answer: null,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: Date.now() - t0,
        error: `gateway ${input.model} ${res.status}: ${txt.slice(0, 200)}`,
      };
    }
    const data = (await res.json()) as GatewayResponse;
    const msg = data.choices?.[0]?.message;
    const call = msg?.tool_calls?.[0]?.function;
    let answer: Answer | null = null;
    if (call?.arguments) {
      try {
        answer = coerceAnswer(JSON.parse(call.arguments));
      } catch {
        answer = null;
      }
    }
    return {
      answer,
      rawText: input.freeText ? (msg?.content ?? undefined) : undefined,
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      latencyMs: Date.now() - t0,
    };
  } catch (err) {
    return {
      answer: null,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
