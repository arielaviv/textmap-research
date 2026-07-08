"use client";

/**
 * Shared model selector, grouped by vendor and driven by the MODELS registry —
 * the single source of truth for both the workspace chat and the eval sweep.
 * A "custom…" entry accepts any `provider/model` id: unknown ids auto-route
 * through the AI Gateway (modelInfo's fallback), so new vendor models work
 * without a registry edit.
 */

import { useState } from "react";
import { MODELS, modelInfo } from "@/experiments/spatial-repr-eval/core/models";

const CUSTOM = "__custom__";

function vendorOf(id: string): string {
  return id.includes("/") ? id.split("/")[0] : "anthropic";
}

const VENDOR_LABELS: Record<string, string> = {
  anthropic: "Anthropic (direct API)",
  openai: "OpenAI (gateway)",
  google: "Google (gateway)",
  moonshotai: "Moonshot (gateway)",
  deepseek: "DeepSeek (gateway)",
};

export function ModelSelect({
  value,
  onChange,
  size = "md",
  className = "",
}: {
  value: string;
  onChange: (id: string) => void;
  /** "lg" = the prominent chat-input variant. */
  size?: "md" | "lg";
  className?: string;
}) {
  const registered = MODELS.some((m) => m.id === value);
  const [customMode, setCustomMode] = useState(!registered);
  const [customText, setCustomText] = useState(registered ? "" : value);

  const vendors = [...new Set(MODELS.map((m) => vendorOf(m.id)))];
  const sizeCls =
    size === "lg"
      ? "px-3 py-2 text-sm font-medium"
      : "px-2 py-1 text-xs";

  function commitCustom(text: string) {
    const id = text.trim();
    if (id) onChange(id);
  }

  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <select
        value={customMode ? CUSTOM : value}
        onChange={(e) => {
          if (e.target.value === CUSTOM) {
            setCustomMode(true);
          } else {
            setCustomMode(false);
            onChange(e.target.value);
          }
        }}
        aria-label="Model"
        className={`rounded border border-zinc-300 bg-white font-mono ${sizeCls}`}
      >
        {vendors.map((v) => (
          <optgroup key={v} label={VENDOR_LABELS[v] ?? `${v} (gateway)`}>
            {MODELS.filter((m) => vendorOf(m.id) === v).map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
                {m.vision ? "" : " · no vision"}
              </option>
            ))}
          </optgroup>
        ))}
        <option value={CUSTOM}>custom (any provider/model id)…</option>
      </select>
      {customMode && (
        <input
          value={customText}
          onChange={(e) => setCustomText(e.target.value)}
          onBlur={() => commitCustom(customText)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitCustom(customText);
          }}
          placeholder="provider/model"
          aria-label="Custom gateway model id"
          className={`w-44 rounded border border-zinc-300 bg-white font-mono ${sizeCls}`}
        />
      )}
      {!modelInfo(value).vision && (
        <span className="text-[10px] text-zinc-400" title="Image arm is skipped for this model">
          no vision
        </span>
      )}
    </span>
  );
}
