/**
 * Per-category hints — the OptiMind transplant (arXiv 2509.22979): error
 * analysis over logged failures → a hint library injected at inference.
 *
 * EVERY hint traces to a measured error pattern (cited inline). Hints may be
 * arm-specific because the failure modes are: e.g. on `crossing`, json's
 * wrong answers are 33/37 EMPTY (under-detection) while textmap2's name
 * spurious cables (raster over-detection) — certify-haiku-v23 runlog.
 *
 * Integrity: hints describe HOW TO READ a representation, never a scene fact
 * or an answer. They are enabled only by config (hints arm), reported as a
 * separate condition vs the frozen baseline.
 */

import type { ArmId } from "./engine";

export interface Hint {
  /** Shown to every arm. */
  generic?: string;
  /** Arm-specific reading guidance (keyed by ArmId). */
  byArm?: Partial<Record<ArmId, string>>;
}

export const HINTS: Record<string, Hint> = {
  // Error: when the true answer is the empty set, both arms invent gaps
  // (haiku textmap2 named 1–3 buildings on 26/35 wrong items; every legend
  // d_closure was under 35m — v2.5 finding #6: empty-set aversion).
  coverage_gap: {
    generic:
      "Check each building one by one. If EVERY building has a closure within 35m, the " +
      "correct answer is an empty array — an empty answer is often correct here.",
    byArm: {
      textmap2:
        "Use the legend's d_closure= value per building: a gap exists ONLY where d_closure > 35.",
    },
  },

  // Error asymmetry (certify-haiku-v23): json wrong = 33/37 EMPTY
  // (under-detects), textmap2 wrong = names 1–5 spurious cables
  // (cell-resolution over-detection).
  crossing: {
    byArm: {
      json:
        "Crossings DO occur. For each cable, test whether its segment passes through any " +
        "building polygon it does not terminate at — do the segment-polygon check per cable.",
      textmap2:
        "The grid over-reports: a cable glyph merely TOUCHING a '#' edge cell is usually not " +
        "a true crossing. Count only cables whose glyphs pass through a building's interior " +
        "cells, and always exclude the cable's own source/target building.",
    },
  },

  // Error: models trace grid glyphs for connectivity (path accuracy jumped
  // +35 when the GEOMETRY vs TOPOLOGY protocol line was added; residual
  // failures still show glyph-traced orderings).
  topology: {
    byArm: {
      textmap2:
        "Do not trace cable glyphs. Build the chain ONLY from the legend: the building's " +
        "serving closure (serves=), then the CABLES section source -> target links up to the CO.",
    },
  },

  // Error: both arms name 1–3 wrong buildings (blockage wrong=58 per arm,
  // haiku). The straight line must be walked, not guessed.
  blockage: {
    generic:
      "Construct the straight segment between the two endpoints first, then test each " +
      "building for intersection with that segment. Buildings near the line but not ON it " +
      "do not count.",
    byArm: {
      textmap2:
        "Walk the grid cells the straight line passes through (interpolate between the two " +
        "endpoint cells); report buildings whose '#' cells the walk enters, except the target.",
    },
  },

  // Error (GeoFM external run): textmap detected containment but INVERTED
  // direction on 90/200 'contains' items (said within). Direction is a
  // reading rule, not a geometry problem.
  geofm_pair: {
    byArm: {
      textmap2:
        "Direction rule: if every b-cell is also an a-cell (and A has more cells), then " +
        "A CONTAINS B. If every a-cell is also a b-cell, then A is WITHIN B. Check which " +
        "set is the subset before choosing contains vs within.",
      wkt:
        "Direction rule: A contains B when all of B's vertices lie inside/on A and A extends " +
        "beyond B. A is within B in the reverse case. Verify which geometry is larger before " +
        "choosing contains vs within.",
    },
  },
};

/** Compose the hint text for a question+arm (empty string when none). */
export function hintFor(questionId: string, arm: ArmId): string {
  const h = HINTS[questionId];
  if (!h) return "";
  const parts = [h.generic, h.byArm?.[arm]].filter(Boolean);
  return parts.length ? `\nHINT: ${parts.join(" ")}` : "";
}
