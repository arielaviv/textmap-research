"use client";

/**
 * Scale-sweep chart: accuracy (y) vs avg input tokens (x), one line per
 * representation arm, one point per AOI scale level (marker size grows with
 * scale). Hand-drawn SVG — no chart dependency. The interesting shape: JSON/WKT
 * points march right (token cost grows with the map) while textmap stays put.
 *
 * Colors are a CVD-validated categorical set (worst adjacent ΔE 24.2, light
 * surface); identity is never color-alone — each line carries a direct label at
 * its end and the per-scale table sits beside the chart.
 */

import { useState } from "react";

export interface ScalePoint {
  scaleM: number;
  arm: string;
  n: number;
  acc: number;
  lo: number;
  hi: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  avgLatencyMs: number;
}

// Fixed arm → color assignment (never cycled; filters must not repaint survivors).
const ARM_COLORS: Record<string, string> = {
  json: "#2a78d6",
  ascii: "#1baf7a",
  textmap: "#008300",
  wkt: "#eda100",
  image: "#4a3aa7",
  verdict: "#e34948",
};
const FALLBACK_COLOR = "#52514e";
const armColor = (arm: string): string => ARM_COLORS[arm] ?? FALLBACK_COLOR;

const W = 660;
const H = 380;
const M = { l: 52, r: 96, t: 16, b: 44 };

export function ScaleChart({ data }: { data: ScalePoint[] }) {
  const [hover, setHover] = useState<ScalePoint | null>(null);
  if (data.length === 0) return null;

  const arms = [...new Set(data.map((d) => d.arm))];
  const levels = [...new Set(data.map((d) => d.scaleM))].sort((a, b) => a - b);
  const maxTok = Math.max(...data.map((d) => d.avgInputTokens), 1);

  const x = (tok: number): number => M.l + (tok / (maxTok * 1.08)) * (W - M.l - M.r);
  const y = (acc: number): number => M.t + (1 - acc) * (H - M.t - M.b);
  // Marker size is the scale encoding (ordered small→large with the AOI size).
  const r = (scaleM: number): number => 4 + levels.indexOf(scaleM) * 1.5;

  const xTicks = [0.25, 0.5, 0.75, 1].map((f) => Math.round((maxTok * f) / 100) * 100);

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full max-w-[660px]"
        role="img"
        aria-label="Accuracy versus average input tokens per representation arm across map scales"
      >
        {/* gridlines + y axis (accuracy) */}
        {[0, 0.25, 0.5, 0.75, 1].map((a) => (
          <g key={a}>
            <line x1={M.l} x2={W - M.r} y1={y(a)} y2={y(a)} stroke="#e1e0d9" strokeWidth={1} />
            <text x={M.l - 8} y={y(a) + 3} textAnchor="end" fontSize={10} fill="#898781">
              {Math.round(a * 100)}%
            </text>
          </g>
        ))}
        {/* x ticks (tokens) */}
        {xTicks.map((t) => (
          <text key={t} x={x(t)} y={H - M.b + 16} textAnchor="middle" fontSize={10} fill="#898781">
            {t >= 1000 ? `${(t / 1000).toFixed(t % 1000 === 0 ? 0 : 1)}k` : t}
          </text>
        ))}
        <text x={(M.l + W - M.r) / 2} y={H - 6} textAnchor="middle" fontSize={11} fill="#52514e">
          avg input tokens per question
        </text>
        <text
          x={12}
          y={(M.t + H - M.b) / 2}
          textAnchor="middle"
          fontSize={11}
          fill="#52514e"
          transform={`rotate(-90 12 ${(M.t + H - M.b) / 2})`}
        >
          accuracy
        </text>
        <line x1={M.l} x2={W - M.r} y1={y(0)} y2={y(0)} stroke="#c3c2b7" strokeWidth={1} />

        {arms.map((arm) => {
          const pts = data
            .filter((d) => d.arm === arm)
            .sort((a, b) => a.scaleM - b.scaleM);
          const color = armColor(arm);
          const last = pts[pts.length - 1];
          return (
            <g key={arm}>
              <polyline
                points={pts.map((p) => `${x(p.avgInputTokens)},${y(p.acc)}`).join(" ")}
                fill="none"
                stroke={color}
                strokeWidth={2}
              />
              {pts.map((p) => (
                <g key={`${arm}-${p.scaleM}`}>
                  {/* Wilson CI whisker */}
                  <line
                    x1={x(p.avgInputTokens)}
                    x2={x(p.avgInputTokens)}
                    y1={y(p.lo)}
                    y2={y(p.hi)}
                    stroke={color}
                    strokeWidth={1}
                    opacity={0.45}
                  />
                  {/* marker (size ↑ with scale) on a 2px surface ring */}
                  <circle
                    cx={x(p.avgInputTokens)}
                    cy={y(p.acc)}
                    r={r(p.scaleM) + 2}
                    fill="#ffffff"
                  />
                  <circle
                    cx={x(p.avgInputTokens)}
                    cy={y(p.acc)}
                    r={r(p.scaleM)}
                    fill={color}
                    onMouseEnter={() => setHover(p)}
                    onMouseLeave={() => setHover(null)}
                  />
                </g>
              ))}
              {/* direct label at line end — ink, not series color */}
              {last && (
                <text
                  x={x(last.avgInputTokens) + r(last.scaleM) + 6}
                  y={y(last.acc) + 3}
                  fontSize={11}
                  fill="#52514e"
                >
                  {arm}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {/* legend: arms (color) + scale levels (marker size) */}
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-600">
        {arms.map((arm) => (
          <span key={arm} className="flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: armColor(arm) }}
            />
            {arm}
          </span>
        ))}
        <span className="text-zinc-400">·</span>
        <span className="flex items-center gap-1.5">
          {levels.map((l) => (
            <span key={l} className="flex items-center gap-0.5">
              <span
                className="inline-block rounded-full bg-zinc-400"
                style={{ width: 2 * (4 + levels.indexOf(l) * 1.5) * 0.75, height: 2 * (4 + levels.indexOf(l) * 1.5) * 0.75 }}
              />
              {l}m
            </span>
          ))}
        </span>
      </div>

      {hover && (
        <div className="pointer-events-none absolute top-2 right-2 rounded border border-zinc-300 bg-white px-2.5 py-1.5 text-xs shadow-sm">
          <div className="font-medium text-zinc-900">
            {hover.arm} · {hover.scaleM}m
          </div>
          <div className="text-zinc-600">
            acc {Math.round(hover.acc * 100)}% ({Math.round(hover.lo * 100)}–
            {Math.round(hover.hi * 100)}%) · n={hover.n}
          </div>
          <div className="text-zinc-600">
            {hover.avgInputTokens.toLocaleString()} tok in · {hover.avgOutputTokens} out ·{" "}
            {(hover.avgLatencyMs / 1000).toFixed(1)}s
          </div>
        </div>
      )}
    </div>
  );
}
