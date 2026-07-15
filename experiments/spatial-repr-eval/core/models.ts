/**
 * Model registry for the eval sweep. Anthropic ids go through the Anthropic SDK;
 * `provider/model` ids go through the Vercel AI Gateway (one AI_GATEWAY_API_KEY).
 * `vision` gates the image arm — text-only models simply don't get image tasks.
 */

export type ModelProvider = "anthropic" | "gateway";

export interface ModelInfo {
  id: string;
  label: string;
  provider: ModelProvider;
  vision: boolean;
  /** False for models that reject sampling params (Opus 4.7+/Fable 5 return 400
   *  on `temperature`) — the caller must omit it. Default true. */
  acceptsTemperature?: boolean;
  /** Max output tokens per call. Models with always-on thinking spend thinking
   *  tokens INSIDE this budget, so they need far more than the answer size. */
  maxTokens?: number;
  /** Always-on thinking (Fable 5): thinking can't be disabled and historically
   *  conflicts with forced tool_choice — use auto + a MUST-call instruction. */
  alwaysThinking?: boolean;
}

export const MODELS: ModelInfo[] = [
  // Anthropic ladder: cheap → frontier (the cheap-model+representation story).
  { id: "claude-haiku-4-5-20251001", label: "claude-haiku-4-5", provider: "anthropic", vision: true },
  { id: "claude-sonnet-4-6", label: "claude-sonnet-4-6", provider: "anthropic", vision: true },
  {
    id: "claude-opus-4-8",
    label: "claude-opus-4-8",
    provider: "anthropic",
    vision: true,
    acceptsTemperature: false,
  },
  {
    id: "claude-fable-5",
    label: "claude-fable-5",
    provider: "anthropic",
    vision: true,
    acceptsTemperature: false,
    alwaysThinking: true,
    maxTokens: 16000,
  },
  // Anthropic via the gateway (same models, billed to Vercel credits instead
  // of the Anthropic account — used when the Anthropic balance is empty).
  { id: "anthropic/claude-haiku-4.5", label: "haiku-4.5 (gw)", provider: "gateway", vision: true },
  {
    id: "anthropic/claude-sonnet-4.6",
    label: "sonnet-4.6 (gw)",
    provider: "gateway",
    vision: true,
  },
  // Cross-vendor points (ids verified against gateway /v1/models).
  { id: "openai/gpt-4o", label: "gpt-4o", provider: "gateway", vision: true },
  { id: "openai/gpt-4o-mini", label: "gpt-4o-mini", provider: "gateway", vision: true },
  // gpt-5 is a reasoning model: rejects temperature, thinks inside the output
  // budget — same handling as fable.
  {
    id: "openai/gpt-5",
    label: "gpt-5",
    provider: "gateway",
    vision: true,
    acceptsTemperature: false,
    maxTokens: 16000,
  },
  {
    id: "openai/gpt-5-mini",
    label: "gpt-5-mini",
    provider: "gateway",
    vision: true,
    acceptsTemperature: false,
    maxTokens: 16000,
  },
  { id: "google/gemini-2.5-flash", label: "gemini-2.5-flash", provider: "gateway", vision: true },
  { id: "google/gemini-2.5-pro", label: "gemini-2.5-pro", provider: "gateway", vision: true },
  {
    id: "xai/grok-4.1-fast-non-reasoning",
    label: "grok-4.1-fast",
    provider: "gateway",
    vision: false,
  },
  { id: "deepseek/deepseek-v3.2", label: "deepseek-v3.2", provider: "gateway", vision: false },
  { id: "alibaba/qwen-3-235b", label: "qwen-3-235b", provider: "gateway", vision: false },
  { id: "moonshotai/kimi-k2", label: "kimi-k2", provider: "gateway", vision: false },
  { id: "deepseek/deepseek-chat", label: "deepseek-chat", provider: "gateway", vision: false },
];

const BY_ID = new Map(MODELS.map((m) => [m.id, m]));

/** Look up a model; unknown ids fall back to gateway (if `provider/model`) or
 *  Anthropic, vision-on, so a new id still runs. */
export function modelInfo(id: string): ModelInfo {
  return (
    BY_ID.get(id) ?? {
      id,
      label: id,
      provider: id.includes("/") ? "gateway" : "anthropic",
      vision: true,
    }
  );
}

export function isVisionModel(id: string): boolean {
  return modelInfo(id).vision;
}

/** Default benchmark set — every registered model. */
export const BENCHMARK_MODELS: string[] = MODELS.map((m) => m.id);
