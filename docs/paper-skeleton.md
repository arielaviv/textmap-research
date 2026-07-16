# Paper skeleton — GeoGlyph (rev 2026-07-17, post-program)

**Title:** *GeoGlyph: Engineered Text Maps Unlock Spatial Reasoning in LLMs*
(alt: *The Representation Is the Bottleneck: Text Maps, Reading Pipelines,
and Executors for LLM Map Reasoning*)

**The one-sentence claim:** the same frontier model reads the same map at
~35% or ~75%+ accuracy depending only on how the map is written and read —
representation, not scale, is the bottleneck, and an engineered
representation compounds with reading protocols, executors, and fine-tuning.

## 1. Introduction
- Agents increasingly operate over geospatial stores; the data arrives as
  raw geometry (GeoJSON/WKT) or rendered images. None of these is readable:
  GeoJSON is flat at 19.5-44% across 11 models from 8 labs — and does not
  improve with model scale (haiku 38.7 ≈ sonnet 38.5 ≈ opus 34.5, same maps).
- Contributions: (1) GeoGlyph, an engineered text-map representation (aligned
  layers, tokenizer-aware cells, exact-measurement legend, reading protocol)
  with four design principles and a labeled precomputation boundary;
  (2) a reading pipeline (error-derived hints + category-aware extraction)
  that closes the extraction gap exactly to its measurable ceiling;
  (3) a function-args geometry executor that breaks that ceiling — and
  AMPLIFIES the representation gap rather than equalizing it;
  (4) GeoGlyph-8B, a $15 LoRA that distills the pipeline into one call;
  (5) an oracle-graded benchmark over real OSM scenes (3 morphologies,
  16 question types), fully pre-registered with published prediction misses.

## 2. Key insights (OptiMind-style box)
1. The representation, not the model, is the bottleneck (11-model table).
2. A representation = format + measurements + reading protocol (ablations).
3. Rendered images are the worst map interface (18.7%, 32% hallucinated ids;
   replicated cross-vendor).
4. The extraction-gap ceiling is measurable: precomputed-answers arm = 61.5
   on haiku; the reading pipeline reaches exactly it (59.5-61.5). It
   separates can't-read from can't-compute.
5. Executors break the ceiling ONLY when the representation carries exact
   geometry (rings): 0→90 on line-intersection; approximation in either
   direction poisons an honest executor (probe pair). Tools AMPLIFY the
   format gap (+8.3 plain → +25/+28 tooled).
6. The transplant boundary: representation-native mechanisms transfer
   (hints, scan); executor-dependent ones (voting, self-correction) fail
   without a solver-shaped loop — measured negative results.
7. Thinking models internalize the pipeline (gemini −1.0; the pipeline is
   cheap-model technology) — and cheap-model + GeoGlyph ≈ frontier-model +
   raw format at ~1/30 cost.
8. SFT distills the pipeline into a single call on an 8B (v1/v2 numbers).

## 3. Method
### 3.1 The GeoGlyph artifact (Algorithm 1 = docs/paper-assets/algorithm-textmap.md)
- P1 lossless-at-query-time (two aligned layers, unoccluded network);
  P2 tokenizer-aligned (one code point per cell, space-separated);
  P3 self-locating (rulers + GRID REF affine); P4 dual-coded (grid gestalt +
  exact-measurement legend sharing the answer id namespace); reading
  protocol (cross-reference, geometry-vs-topology, thresholds).
- The precomputation dial and its boundary (entity-local world facts in,
  question-specific judgments out; `verdict` arm = the labeled ceiling).
  Labeled revisions: v2.6 zoom, v2.8 footprint rings + meter cable
  endpoints (executor inputs). Deferred: v2.7 feeds= (path's known gap).
### 3.2 The reading pipeline (H+S variants)
- Error-derived hints (verbatim library = paper-assets/prompts.md §4);
  category-aware scan (extraction briefs per question class); citations;
  zoom. Screened 12 conditions; voting/turns/few-shot dropped (negative).
### 3.3 The executor (tools arm)
- Six generic planar primitives; model-marshaled inputs; the tool round
  never sees the scene. Category routing (compute-bound only). The probe
  ladder as a methods narrative (invented rings → fat bboxes → exact rings).
### 3.4 GeoGlyph-8B (SFT)
- 6k examples (both formats, oracle labels self-checked, synthetic traces =
  distilled scan), seeds disjoint, hold-out question types excluded;
  LoRA r16, 1 epoch, $15.20, 15 min. v2 = 1,000 scenes + error-loop
  oversampling (bundled delta, disclosed).

## 4. Experimental setup
- Real OSM scenes: NYC (60 certified + fresh sets), London, Phoenix
  (3 morphologies); synthetic generator for training/probes.
- 10 core questions (8 categories) + 6 hold-outs written post-freeze;
  oracle-graded; forced structured answers (or disclosed trailing-JSON for
  no-tool models); isolate mode; temp 0; metrics incl. tokens/latency/
  hallucinated-ids/missing-info. Pre-registration protocol: predictions +
  kill criteria committed before every run; 7 misses published.

## 5. Results
### 5.1 Formats (haiku, 60 maps): 47.0 / 38.7 / 36.5 / 18.7 (McNemar p=1e-4)
### 5.2 Eleven models × plain (the flat-GeoJSON figure) + pipeline column
  (8/9 positive, p=.002; gemini negative = insight 7; fable cells [PENDING])
### 5.3 The ladder (haiku): 46.0 → 59.5 (reading = ceiling 61.5) → 72.5
  (blanket tools) → **75.5 routed = final recipe** (123% of ceiling; all
  category predictions hit; cheaper than blanket).
### 5.4 Tools amplify the gap: textmap 72.5 vs json 47.5 vs wkt 44.5 under
  IDENTICAL machinery (preregs ≥8 landed at 3×).
### 5.5 Generalization: hold-outs +5.2 (p=.051); London +4.5 (p=.023) +
  pipeline cell [PENDING]; Phoenix [PENDING]; scale 350→2800m (textmap ≥ at
  all sizes, accuracy-per-token ~1.9×, gap converges — frontier figure);
  repeats ×3 (spread ≤1.0).
### 5.6 External: GeoFM Task-1 (their 1,400 triplets, their grading): plain
  LOST 56.6 vs 58.9 (kill invoked, direction inversion diagnosed); one
  symmetric direction rule → **61.9 > 58.4 (flip)**; haiku+GeoGlyph within
  1pt of their GPT-4 zero-shot at a fraction of cost.
### 5.7 GeoGlyph-8B: base control 12.5-20 / 14.5-31.7; v1 [PENDING —
  fingerprint-gated eval in flight]; v2 [PENDING]; +tools zero-shot (E3)
  [PENDING].
### 5.8 Frontier sniff: fable-5 full stack [PENDING — prereg 80-90, kill <70].

## 6. Negative results & incidents (own section — the reviewers' favorite)
- Voting −3 at 10× cost; 5-turn self-correction −3; few-shot −5 (interferes
  with scan); citations +0.3 (noise). v2.7 bboxes KILLED by its own rule.
- Incident log (10 entries): headless-billing lessons, truncation-as-silent-
  failure (gemini 80/100, fixed budget-matched), commute-contaminated run
  (rerun), platform serving saga. All in the public diary.

## 7. Limitations
- Path category: ground truth rests on an unstated homing convention the
  explicit pipeline surfaces (v2.7 fix deferred — honesty note).
- Compute-bound reading without tools stays hard (crossing raster limits).
- FTTH-flavored schema (generic mechanism, one domain vocabulary).
- Code-over-file agents saturate any parseable format — our claim scopes to
  direct reading + function-args regimes (discussion).

## 8. Reproducibility
- Public repo: harness, prompts (verbatim appendix), per-run runlog.jsonl,
  pre-registration notebook, research diary with full money ledger (~$350
  self-funded), GeoGlyph-8B weights (HF release with paper).

## Appendices
A. Algorithm 1 + worked example (paper-assets/: map PNG, both layers,
   GeoJSON, WKT, all prompts). B. Question set (16, verbatim). C. Hint
   library with error provenance. D. GeoFM per-predicate tables. E. SFT
   training data card. F. Incident log.
