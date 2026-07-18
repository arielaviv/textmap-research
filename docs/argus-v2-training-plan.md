# Argus v2 training plan — folds in the improved (93%) pipeline

Supersedes the v2 prereg block in `textmap-v2.md`. Companion to
`docs/pipeline-improvements-research.md` (the 5-agent research) and the measured
validation below. Nothing here has been trained yet; this is the plan to lock
before generating data / spending on the 20B.

## 0. What changed since the original v2 prereg

- **Pipeline improved 75.5 → 93.0** (haiku, n=100, real-NYC, all 10 questions) by
  enriching the legend with world-facts + adding executor **reducer** ops + fixing
  hints. Per-category: crossing 60→100, road_misplacement 50→100, path ~40→100,
  mixed 50→80, blockage 90, enclosure 80, nearest_offstreet 30/40→**60** (the
  residual genuine-reasoning column). Committed `fe0fe02` (hints) + `fb18e50`
  (reducer ops + legend fields), tsc-green, integrity-clean.
- **Cheap verification (~$25 total) settled three things before the $200 20B:**
  the executor-verified **self-correct loop is dead** (+1.7 noise); **precompute +
  reducer-ops** is the real lever; the mixed frontier is a *reduce/enumerate/argmin*
  problem, not perception.
- **Locked decisions:** real-OSM-only training, geographically **disjoint** train/
  eval AOIs, **vocabulary augmentation**, **2-call masked** tool traces.

## 1. The pipeline Argus must distil (the 93% recipe)

- **Representation:** textmap (grid + legend, coupled) with `worldFacts` ON — legend
  carries `inside=`, `d_closure=`, `d_street=`, `serves=`, `on=`, `street=`,
  `served_by=`, `up=`, `terminates_in=` (all oracle-matched, question-agnostic).
  **`hull=` was REMOVED** after the 2026-07-19 independent audit: it printed the
  enclosure grader's own `interiorBuildings()` output per-entity — the answer
  verbatim, not a world-fact. Enclosure now rides the `convex_hull` executor op
  (genuine marshal-compute); expect a few points off the 93 on re-measure.
- **Reading pipeline:** category-aware scan, fixed per-category hints (topology bug
  fixed; `containment`/`onstreet`/`nearest` added; tool-mode `crossing`), citations,
  zoom. No self-correction, no voting.
- **Executor (2-call, routed):** geometry primitives + **reducer ops**
  `segments_cross_polygons` (crossing), `filter_threshold` (road_misplacement),
  `nearest_where` (nearest_offstreet). Compute categories route to the right op; the
  engine does the enumerate/threshold/argmin, the model only marshals.

## 2. Training-data recipe (fixes the three defects the research found)

**Defect A — real 2-call, masked.** The current `sft-generate.mjs` bakes the tool
result (= the answer) into a single supervised sequence → hallucinated geometry.
Emit three segments per compute example and **mask the tool-result tokens**:
```
assistant#1 (loss=1):  EXTRACTION (inputs, not the verdict) + TOOL_CALLS {reducer op}
tool        (loss=0):  TOOL_RESULTS  ← engine-produced, MASKED
assistant#2 (loss=1):  ANSWER {json}
```
Read-bound categories stay single-call EXTRACTION+ANSWER (their answer is a legend
field). At inference run the true loop (model→tool_call→engine→model→answer).

**Defect B — real task-schema diversity (the hold-out fix).** Paraphrasing 10
questions is input-side only; v1 hold-out was +0 because the 6 hold-out types emit
*schemas the model never produced* (count/bearing/quadrant). Build **>300 unique
task templates across ~30-50 families**, including novel output shapes (`{count}`,
`{meters}`, `{bearing_deg}`, `{quadrant}`, `{orderedIds}`, `{relation}`), composed
from existing scene primitives. **Hold out whole task families** (not just
phrasings) for the generalization test.

**Defect C — spatial train/eval split.** Disjoint seed integers still jitter within
the same ~2 km Manhattan box → real AOIs overlap. Go **real-OSM-only**, widen the
AOI jitter, **partition each city into disjoint train vs eval tiles**; keep London/
Phoenix eval-only. "Disjoint seeds" ≠ "disjoint geography."

**Also fold in:**
- **Vocabulary skinning:** rotate ≥5 ontology skins (FTTH / water / electric /
  sensor-network / logistics) + ~20% generic `node/edge/region`, holding geometry
  fixed — delivers vocabulary-invariance / domain-generality at ~+0 tokens.
- **General-instruction replay:** 5-15% high-quality generic instructions (resists
  template collapse).
- **Repair traces:** ~5%, verifier-signal only (bad-id / schema / frame-mismatch).
  **No arithmetic self-correction** (measured null result).
- **Composition:** ~uniform across families, 2-3× oversample compute-bound
  (crossing/line-int/mixed/blockage); keep 50/50 textmap2/json arms; ~35-40% carry a
  tool trace. **Size:** ~15-30k examples, ~50-70M tokens.

## 3. Model + LoRA

- **Argus-8B** — Llama-3.1-8B; LoRA **r32 / α64**, lr 1e-4, 2 epochs, **all linear
  layers** (not just q/v). Lock the chat template (client-side + `/generate` per the
  runbook).
- **Argus-20B** — gpt-oss-20B; LoRA **r32 / α64**, **lr 5e-5-7e-5** (lower — overfits
  faster), 1-2 epochs, adapters must cover the **expert MLPs**. **Harmony format is
  mandatory**: reasoning (EXTRACTION/TOOL_CALLS) in the *analysis* channel, ANSWER in
  *final*; MXFP4 base + bf16 adapter → serve base+adapter.
- **Serving:** HF A100/TGI per the runbook — *or* Together if their fine-tune-serving
  flow is fixed (see the Nikitha thread). Verify with the no-system-prompt fingerprint
  + tensor byte-compare **before any eval spend**.

## 4. Validation gates (revised bands — pipeline is now 93, not 75.5)

Prereg (commit before training):
- **Argus-8B-v2** (distilled, 2-call executor): core **72-85**; **hold-out gap
  RESTORED to ≥ +5** (the real target — the v1 failure).
- **Argus-20B**: core **82-90**; ≥ fable-parity.
- **Kill:** 8B core < 70, *or* hold-out still +0 ⇒ recipe insufficient (diversity or
  masking), reported honestly.

Sequence (never spend big on an unvalidated recipe):
`8B canary ($66) → check bands + hold-out → 20B ($200)`.

Eval rig (apples-to-apples): same config + executor, **base-model control**,
Argus's own verdict ceiling, hold-out (types **and** cities),
tokens/latency/hallucination, Wilson CI + McNemar.

**Audit-driven eval hygiene (2026-07-19):**
- The legacy `aoiForCity` jitter is degenerate — `(seed*73)%100` depends only on
  `seed % 100`, so ALL historical seeds collapse onto a 100-tile lattice, and
  v1's "disjoint" train seeds 51000+i sat on EXACTLY the eval AOIs of 2000+i
  (full geographic contamination). v2 train tiles (sft-generate-v2) are hashed
  over the whole bundled slice and rejected against ALL 100 lattice tiles —
  disjoint from every legacy eval seed by construction.
- The 93 was measured on the exact 10 scenes (seeds 2000-2009) the improvements
  were tuned on — **in-sample**. The firm-up run must use fresh lattice
  residues, e.g. seeds **2020-2059** (residues 20-59, never used for tuning),
  and report 2000-2019 separately for comparability.

## 5. Honesty ledger (for the paper)

- **93% is a SYSTEM result.** The legend precompute + executor move work *out* of the
  LLM: read categories test "read a rich, oracle-clean attribute table"; compute
  categories test "marshal coordinates into a tool." `nearest_offstreet` (60%) is the
  residual *genuine composite-reasoning* column — **keep it un-shortcut** so the
  reasoning claim stays honest.
- All legend fields are per-entity **world-facts** (computed by the oracle's own
  functions, question-agnostic — same class as `inside=`); reducer ops compute only
  on model-supplied values and never see the scene. Pre-register each as a labeled
  artifact revision.
- Grid + legend are **coupled by design** (legend rows are anchored to grid cells; the
  cross-reference is the mechanism). Claim the *bundle* beats geojson (proven); the
  optional 4-arm grid-vs-legend ablation would show synergy, not a single "key".

## 6. Open work before generating data (all free / code)

1. Rewrite `sft-generate.mjs`: 2-call masking, `worldFacts` legend + reducer-op tool
   traces, >300-template task bank, vocabulary skinning, spatial tile split, general
   replay slice.
2. Build the task-family bank (the >300 templates + novel output serializers +
   held-out families).
3. Decide the precompute line for training: keep 1-2 categories (e.g. nearest_offstreet,
   a non-precomputed enclosure variant) as genuine-reasoning tests.
4. Then: 8B canary → 20B, gated on §4.
