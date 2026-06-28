/**
 * Vercel AI Gateway client (OpenAI-compatible) for the repr-eval workspace chat.
 * One key (AI_GATEWAY_API_KEY) → many providers via `provider/model` strings
 * (openai/gpt-4o, google/gemini-2.5-flash, moonshotai/kimi-k2, …). Direct fetch,
 * no extra dependency. Used for the multi-model benchmark the workspace drives;
 * the existing claude-* ids still go through the Anthropic SDK path.
 */

const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/chat/completions";

export interface OpenAITool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string | null; tool_calls?: OpenAIToolCall[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface GatewayResult {
  content: string;
  toolCalls: OpenAIToolCall[];
  usage: { promptTokens: number; completionTokens: number };
}

/** One chat-completion round through the gateway. Throws with a clear message
 *  when the key is missing or the upstream provider errors. */
export async function gatewayChat(
  model: string,
  messages: OpenAIMessage[],
  tools: OpenAITool[],
): Promise<GatewayResult> {
  const key = process.env.AI_GATEWAY_API_KEY;
  if (!key) {
    throw new Error(
      "AI_GATEWAY_API_KEY not set — add it (with billing) in Vercel to use gateway models " +
        "like openai/gpt-4o, google/gemini-2.5-flash, moonshotai/kimi-k2.",
    );
  }
  const res = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages,
      tools,
      tool_choice: "auto",
      max_tokens: 8000,
      stream: false,
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`gateway ${model} error ${res.status}: ${txt.slice(0, 300)}`);
  }
  const data = (await res.json()) as ChatCompletionResponse;
  const msg = data.choices?.[0]?.message;
  return {
    content: msg?.content ?? "",
    toolCalls: msg?.tool_calls ?? [],
    usage: {
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
    },
  };
}
