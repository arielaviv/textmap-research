/** Statistics for the eval: Wilson CIs for accuracy + McNemar's test for paired arm comparisons. */

import type { ItemResult } from "./engine";

export interface Proportion {
  n: number;
  correct: number;
  acc: number;
  lo: number;
  hi: number;
}

/** Wilson score interval (95%) for a binomial proportion. */
export function wilson(correct: number, n: number): Proportion {
  if (n === 0) return { n: 0, correct: 0, acc: 0, lo: 0, hi: 0 };
  const z = 1.96;
  const p = correct / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { n, correct, acc: p, lo: (centre - margin) / denom, hi: (centre + margin) / denom };
}

function erfc(x: number): number {
  // Abramowitz & Stegun 7.1.26 approximation.
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const ans =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t *
                              (-1.13520398 +
                                t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? ans : 2 - ans;
}

export interface McNemar {
  b: number; // arm A correct, arm B wrong
  c: number; // arm A wrong, arm B correct
  statistic: number;
  p: number;
}

/** McNemar's test with continuity correction over paired booleans. */
export function mcnemar(aCorrect: boolean[], bCorrect: boolean[]): McNemar {
  let b = 0;
  let c = 0;
  for (let i = 0; i < aCorrect.length; i++) {
    if (aCorrect[i] && !bCorrect[i]) b++;
    else if (!aCorrect[i] && bCorrect[i]) c++;
  }
  if (b + c === 0) return { b, c, statistic: 0, p: 1 };
  const statistic = (Math.abs(b - c) - 1) ** 2 / (b + c);
  const p = erfc(Math.sqrt(statistic / 2)); // chi-square, 1 df
  return { b, c, statistic, p };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface ArmSummary extends Proportion {
  arm: string;
  avgInputTokens: number;
  avgOutputTokens: number;
  avgLatencyMs: number;
  /** Share of items citing at least one nonexistent entity id (errors count as clean). */
  hallucinationRate: number;
  /** Share of items where the model reported missing information. */
  missingInfoRate: number;
}
export interface ArmCategorySummary extends Proportion {
  arm: string;
  category: string;
}
export interface PairwiseSummary {
  armA: string;
  armB: string;
  mcnemar: McNemar;
  accA: number;
  accB: number;
}

export interface Aggregate {
  perArm: ArmSummary[];
  perArmCategory: ArmCategorySummary[];
  pairwise: PairwiseSummary[];
  totalItems: number;
  errors: number;
}

/** A full per-arm aggregate scoped to one model — for the benchmark matrix. */
export interface ModelAggregate extends Aggregate {
  model: string;
}

/** One aggregate per model (so multi-model sweeps don't average across models). */
export function aggregateByModel(items: ItemResult[]): ModelAggregate[] {
  const models = [...new Set(items.map((r) => r.model))];
  return models.map((model) => ({ model, ...aggregate(items.filter((r) => r.model === model)) }));
}

/** One row per (scale level, arm) — the accuracy-vs-tokens curve of the scale sweep. */
export interface ScaleArmSummary extends Proportion {
  scaleM: number;
  arm: string;
  avgInputTokens: number;
  avgOutputTokens: number;
  avgLatencyMs: number;
}

export function aggregateByScale(items: ItemResult[]): ScaleArmSummary[] {
  const scaled = items.filter((r) => r.scaleM != null);
  const levels = [...new Set(scaled.map((r) => r.scaleM as number))].sort((a, b) => a - b);
  const arms = [...new Set(scaled.map((r) => r.arm))];
  const out: ScaleArmSummary[] = [];
  for (const scaleM of levels) {
    for (const arm of arms) {
      const rows = scaled.filter((r) => r.scaleM === scaleM && r.arm === arm);
      if (!rows.length) continue;
      out.push({
        scaleM,
        arm,
        ...wilson(rows.filter((r) => r.correct).length, rows.length),
        avgInputTokens: Math.round(rows.reduce((s, r) => s + r.inputTokens, 0) / rows.length),
        avgOutputTokens: Math.round(rows.reduce((s, r) => s + r.outputTokens, 0) / rows.length),
        avgLatencyMs: Math.round(rows.reduce((s, r) => s + r.latencyMs, 0) / rows.length),
      });
    }
  }
  return out;
}

function key(r: ItemResult): string {
  return `${r.sceneId}|${r.questionId}|${r.model}|${r.repeat}`;
}

export function aggregate(items: ItemResult[]): Aggregate {
  const arms = [...new Set(items.map((r) => r.arm))];
  const categories = [...new Set(items.map((r) => r.category))];

  const perArm: ArmSummary[] = arms.map((arm) => {
    const rows = items.filter((r) => r.arm === arm);
    const correct = rows.filter((r) => r.correct).length;
    const inTok = rows.reduce((s, r) => s + r.inputTokens, 0);
    const outTok = rows.reduce((s, r) => s + r.outputTokens, 0);
    const lat = rows.reduce((s, r) => s + r.latencyMs, 0);
    return {
      arm,
      ...wilson(correct, rows.length),
      avgInputTokens: rows.length ? Math.round(inTok / rows.length) : 0,
      avgOutputTokens: rows.length ? Math.round(outTok / rows.length) : 0,
      avgLatencyMs: rows.length ? Math.round(lat / rows.length) : 0,
      hallucinationRate: rows.length ? rows.filter((r) => r.hallucinated).length / rows.length : 0,
      missingInfoRate: rows.length ? rows.filter((r) => r.missingInfo).length / rows.length : 0,
    };
  });

  const perArmCategory: ArmCategorySummary[] = [];
  for (const arm of arms) {
    for (const category of categories) {
      const rows = items.filter((r) => r.arm === arm && r.category === category);
      if (!rows.length) continue;
      perArmCategory.push({
        arm,
        category,
        ...wilson(rows.filter((r) => r.correct).length, rows.length),
      });
    }
  }

  // Pairwise McNemar over matched items (same scene/question/model/repeat).
  const pairwise: PairwiseSummary[] = [];
  for (let i = 0; i < arms.length; i++) {
    for (let j = i + 1; j < arms.length; j++) {
      const aMap = new Map<string, boolean>();
      const bMap = new Map<string, boolean>();
      for (const r of items) {
        if (r.arm === arms[i]) aMap.set(key(r), r.correct);
        if (r.arm === arms[j]) bMap.set(key(r), r.correct);
      }
      const aArr: boolean[] = [];
      const bArr: boolean[] = [];
      for (const [k, av] of aMap) {
        if (bMap.has(k)) {
          aArr.push(av);
          bArr.push(bMap.get(k)!);
        }
      }
      pairwise.push({
        armA: arms[i],
        armB: arms[j],
        mcnemar: mcnemar(aArr, bArr),
        accA: aArr.length ? aArr.filter(Boolean).length / aArr.length : 0,
        accB: bArr.length ? bArr.filter(Boolean).length / bArr.length : 0,
      });
    }
  }

  return {
    perArm,
    perArmCategory,
    pairwise,
    totalItems: items.length,
    errors: items.filter((r) => r.error).length,
  };
}
