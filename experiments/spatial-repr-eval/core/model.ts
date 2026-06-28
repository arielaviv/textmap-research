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
}

export interface AskResult {
  answer: Answer | null;
  inputTokens: number;
  outputTokens: number;
  error?: string;
}

const SYSTEM =
  "You are a precise spatial-analysis assistant for GIS / FTTH network data. " +
  "You are given a representation of a small map (buildings, streets, equipment, cables) and ONE question. " +
  "Reason carefully about the spatial relationships, then call submit_answer with ONLY the requested field(s). " +
  "Ids must match exactly the ids present in the data. Do not invent ids.";

const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/chat/completions";

export async function askModel(input: AskInput): Promise<AskResult> {
  return modelInfo(input.model).provider === "gateway" ? askGateway(input) : askAnthropic(input);
}

async function askAnthropic(input: AskInput): Promise<AskResult> {
  const client = new Anthropic({ apiKey: input.apiKey });

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

  try {
    const resp = await client.messages.create({
      model: input.model,
      max_tokens: 1024,
      temperature: input.temperature,
      system: SYSTEM,
      tools: [
        {
          name: "submit_answer",
          description: "Submit the structured answer to the question.",
          input_schema: ANSWER_TOOL_SCHEMA as unknown as Anthropic.Tool["input_schema"],
        },
      ],
      tool_choice: { type: "tool", name: "submit_answer" },
      messages: [{ role: "user", content }],
    });

    let answer: Answer | null = null;
    for (const block of resp.content) {
      if (block.type === "tool_use" && block.name === "submit_answer") {
        answer = block.input as Answer;
        break;
      }
    }
    return { answer, inputTokens: resp.usage.input_tokens, outputTokens: resp.usage.output_tokens };
  } catch (err) {
    return {
      answer: null,
      inputTokens: 0,
      outputTokens: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

interface GatewayResponse {
  choices?: { message?: { tool_calls?: { function?: { name?: string; arguments?: string } }[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

async function askGateway(input: AskInput): Promise<AskResult> {
  const key = process.env.AI_GATEWAY_API_KEY;
  if (!key) {
    return {
      answer: null,
      inputTokens: 0,
      outputTokens: 0,
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

  try {
    const res = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: input.model,
        temperature: input.temperature,
        max_tokens: 1024,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: userContent },
        ],
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
        stream: false,
      }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return {
        answer: null,
        inputTokens: 0,
        outputTokens: 0,
        error: `gateway ${input.model} ${res.status}: ${txt.slice(0, 200)}`,
      };
    }
    const data = (await res.json()) as GatewayResponse;
    const call = data.choices?.[0]?.message?.tool_calls?.[0]?.function;
    let answer: Answer | null = null;
    if (call?.arguments) {
      try {
        answer = JSON.parse(call.arguments) as Answer;
      } catch {
        answer = null;
      }
    }
    return {
      answer,
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
    };
  } catch (err) {
    return {
      answer: null,
      inputTokens: 0,
      outputTokens: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
