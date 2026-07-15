# Prompts appendix — every prompt the models see, verbatim

Sources of truth: `core/model.ts` (SYSTEM), `core/engine.ts` (scan briefs,
citations, feedback), `core/hints.ts` (hint library), `geofm-task1.mjs`
(external-benchmark prompts). Kept in sync by hand; the code wins on
divergence.

## 1. Eval system prompt (all arms, all models, all conditions)

> You are a precise spatial-analysis assistant for GIS / FTTH network data.
> You are given a representation of a small map (buildings, streets,
> equipment, cables) and ONE question. Reason carefully about the spatial
> relationships, then call submit_answer with ONLY the requested field(s).
> Ids must match exactly the ids present in the data. Do not invent ids.
> If (and only if) the representation truly lacks the information needed to
> answer, also fill `missingInfo` with a brief note of what is missing.

Answers arrive through a forced `submit_answer` tool call against a typed
schema (equipmentIds, cableIds, buildingIds, closureId, onStreet,
equipmentPath, count, direction, quadrant, missingInfo, evidence) — no
free-text grading anywhere in the main benchmark.

## 2. Scan phase (pipeline S; a first call with `freeText`, no tool)

Generic brief (all categories except the two below):

> Do NOT answer yet. First, extract from the representation every fact
> relevant to the question below — one line per relevant entity, with its
> exact ids and measurements as they appear. Be complete: cover every
> entity the question could involve.
>
> QUESTION (for context only): {question}

Category-aware briefs (pipeline v2, `--scan-targets`):

- **path** — extract the CONNECTIVITY GRAPH only: one line per equipment
  entry — its exact id, its kind/role exactly as written, and the full list
  of building/equipment ids it serves (if any); one line per cable with its
  exact id and its two endpoints (source → target). Include EVERY equipment
  entry, even ones that serve nothing (roots/sources are part of paths). Do
  NOT extract positions, distances or streets — this question is answered
  purely by connectivity.
- **on-street** — extract the STREET-PLACEMENT facts only: one line per
  equipment entry with its exact id and every fact the representation
  states about its position relative to streets (the street it sits on, its
  distance to the nearest street, or its coordinates if that is all the
  representation provides). Do NOT extract serves lists or buildings.

The answer call then receives:

> YOUR OWN EXTRACTED FACTS (from your first read — re-verify anything
> doubtful against the representation): {scan output}

No scene fact is ever injected by the harness — the model anchors only on
its own first read (the self-built verdict layer).

## 3. Citations condition (pipeline C)

> Also fill `evidence`: for EVERY id in your answer, one string quoting the
> exact line/entry from the representation that justifies including it.

The grader ignores `evidence` — the forcing function is the point.

## 4. Hint library (pipeline H — complete, with the error each traces to)

Integrity rule: hints teach HOW TO READ a representation, never a scene
fact or an answer. Every entry cites its measured error pattern.

| Question | Arm | Hint (verbatim) | Derived from |
|---|---|---|---|
| coverage_gap | all | "Check each building one by one. If EVERY building has a closure within 35m, the correct answer is an empty array — an empty answer is often correct here." | empty-set aversion: 26/35 wrong items invented gaps |
| coverage_gap | textmap2 | "Use the legend's d_closure= value per building: a gap exists ONLY where d_closure > 35." | same |
| crossing | json | "Crossings DO occur. For each cable, test whether its segment passes through any building polygon it does not terminate at — do the segment-polygon check per cable." | json wrong = 33/37 EMPTY (under-detection) |
| crossing | textmap2 | "The grid over-reports: a cable glyph merely TOUCHING a '#' edge cell is usually not a true crossing. Count only cables whose glyphs pass through a building's interior cells, and always exclude the cable's own source/target building." | textmap2 wrong = 1–5 spurious cables (raster over-detection) |
| topology | textmap2 | "Do not trace cable glyphs. Build the chain ONLY from the legend: the building's serving closure (serves=), then the CABLES section source -> target links up to the CO." | glyph-traced orderings |
| blockage | all | "Construct the straight segment between the two endpoints first, then test each building for intersection with that segment. Buildings near the line but not ON it do not count." | both arms name 1–3 wrong buildings |
| blockage | textmap2 | "Walk the grid cells the straight line passes through (interpolate between the two endpoint cells); report buildings whose '#' cells the walk enters, except the target." | same |
| geofm_pair | textmap2 | "Direction rule: if every b-cell is also an a-cell (and A has more cells), then A CONTAINS B. If every a-cell is also a b-cell, then A is WITHIN B. Check which set is the subset before choosing contains vs within." | GeoFM: 90/200 contains→within inversions |
| geofm_pair | wkt | "Direction rule: A contains B when all of B's vertices lie inside/on A and A extends beyond B. A is within B in the reverse case. Verify which geometry is larger before choosing contains vs within." | symmetric help for the rerun |

## 5. Self-correction feedback (pipeline T — dropped after screening)

The verifier uses ONLY representation-legal signals (hallucinated ids) —
never the oracle; looping "until correct" would leak ground truth:

> PREVIOUS ATTEMPT: {answer}
> FEEDBACK: the ids [{X}] do not exist in this scene. Re-read the
> representation and answer again using only ids that appear in it.

## 6. GeoFM Task-1 (external benchmark) — their prompt, our minimal swap

WKT arm = their verbatim zero-shot system prompt (task1-GPT-4.ipynb).
Textmap arm changes ONLY the format description sentence and the geometry
block; question, predicates, and output format are identical:

> You will be given a text-map rendering of geometries given the subject A
> and reference object B: both are drawn on the SAME aligned grid (one
> character per cell, space-separated; row 0 = north). LAYER A shows only
> geometry A ('a' cells); LAYER B shows only geometry B ('b' cells). The
> layers share the frame — the same (col,row) in both layers is the same
> place on the ground.
> [predicate list + output format: identical to theirs]

Hint rerun (`--hint`): each arm's direction rule from §4 appended as one
extra system bullet — symmetric help, no-hint runs remain the baseline.
