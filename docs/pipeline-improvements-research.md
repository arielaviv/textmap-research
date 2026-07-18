# Pipeline & 20B-training improvement research (overnight, 5-agent deep dive)

Compiled from five parallel Opus research agents (one per theme), each grounded in
the repo code + web literature. Every proposal is integrity-checked against the
"legend carries world-facts, never answers; hints say HOW to read, never scene
values" rule. Ranked, actionable, cheap-first.

---

## The one unifying principle (all five agents independently converged here)

> **Stop asking the model to do the deterministic parts.** Move every
> *reduce / enumerate / filter / threshold / argmin / graph-walk* step into the
> **executor**; materialize every *question-agnostic world-fact and reverse-join*
> into the **legend** as a field; and make each **hint name the correct field and
> forbid the wrong evidence source.** The model's only job is semantic
> translation (reading/marshalling) — which is what it's good at.

This is the PAL / Program-of-Thoughts result (LLMs decompose fine but fail the
*solving*), and it explains every failure we measured — including why the prose
scan-decomposition backfired (40→30): prose decomposition still solves in-head;
you must decompose into **code/executor calls**, not prose.

---

## RANKED MASTER TO-DO (cheap wins first)

### Tier 0 — free, do immediately (text/bug fixes, zero risk, gated by `hints`)
1. **Fix the `topology` hint BUG.** It tells the model to walk the CABLES section
   "source→target up to the CO" — **but no closure→CO cable exists in any scene**
   (the homing edge is only in `feeds=`, and there's a *decoy* closure→closure
   cable). The hint actively misdirects toward a nonexistent path / the decoy.
   Rewrite it to read from `feeds=`, give an explicit ordered walk, make it
   `generic`, and forbid cable ids. *(path agent)*
2. **Add the three MISSING reading hints.** `containment`, `onstreet`, `nearest`
   currently ship with **no hint at all** (`hintFor` returns `""`). Purely
   additive, gated, can only help. *(reading agent)*
   - **`onstreet` is the highest-value** — it has a live field-confusion trap:
     the closure row prints both `on=S0 "Main St"` (nearest *named* street,
     **any distance**) and `d_street=` (the oracle value). The model reads the
     verb-like `on=` and answers `true` even when `d_street > 8`. Hint: *use ONLY
     `d_street ≤ 8`; IGNORE `on=` (it's an identity label, not a placement claim).*
   - **`nearest`**: use `d_closure=` on the building row as a verification anchor;
     consider only `kind=closure` (not cabinets/CO).
   - **`containment`**: read `inside=` on every equipment row incl. the CO;
     empty is a real, common answer (empty-set aversion).
3. **Gate the raster-glyph `crossing` hint OFF when tools are active**, and inject
   a tool-mode hint instead (the current hint pulls the model back to glyph-counting,
   fighting the executor). *(compute agent)*
4. **Add a single always-on empty-set line to the reading-protocol block**
   (generalizes the coverage win to containment + all set-answer questions). *(reading agent)*

### Tier 1 — small labeled legend additions (world-facts, `hull=`-class, low cost)
5. **`street=<oracle nearestStreetName key>` on building AND equipment rows.**
   Buildings currently have no street field; equipment's `on=` is named-only and
   **doesn't match the oracle key** used by `nearest_offstreet`. Required to unblock
   that question. *(mixed + path agents)*
6. **`served_by=<closureId>` on building rows + `up=<upstreamId>` parent pointer on
   each device.** This is the "incident" graph encoding (Talk-Like-a-Graph: lifts
   connectivity 19.8%→53.8%). Turns the path question into a trivial parent-pointer
   walk. `served_by=` is the reverse of the already-printed `serves=`; `up=` is the
   inverse of `feeds=`. *(path agent)*
7. **`terminates_in=<building>` on CABLES rows** — turns crossing's terminal-exclusion
   from id-shape inference into a stated-fact copy; feeds the batch op below. *(compute agent)*
8. **Rename `on=` → `nrst_st=`** to kill the "sits on" verb that seeds the on-street
   confusion at the source. (Labeled artifact revision — mutates baseline.) *(reading agent)*

### Tier 2 — executor **reducer** ops (the mixed/compute unlock, ~50 LoC, integrity-clean)
The executor is currently **map-only** — six ops that each compute ONE result for
ONE input. It has **no reducer** (filter / argmin / enumerate). That is the root
cause of the mixed 50% and crossing 60%. Add:
9. **`segments_cross_polygons`** — batch crossing: rings supplied **once**, all
   cable segments in one dict, per-segment `exclude`. Collapses N ring-copies → 1
   (kills truncation + miscopy + under-enumeration + hand-exclusion). Update
   `countToolOps` to count *segment keys* so a truncated batch fails coverage.
   **crossing 60 → ~80.** *(compute agent)*
10. **`filter_threshold`** — road_misplacement over the already-precomputed
    `d_street=`: model transcribes one `{id: number}` column, engine does
    threshold + enumerate + empty-set. **road 50 → ~85.** *(mixed agent)*
11. **`nearest_where`** — nearest_offstreet: target + `exclude_value` (home street)
    + `{id:{xy,street}}` candidates; engine filters + argmins in ONE coarse call
    (not a distance-call-per-closure chain). With `street=` field, **30 → ~70.** *(mixed agent)*

> Design rule from the literature: **one coarse reducer call the model fills once
> beats an orchestration of many fine calls** — parameter-value marshalling errors
> dominate tool failures (~78.8%), and each repeated coordinate copy is an
> independent mis-transcription die-roll. Keep dicts flat, keys short, meters only.

### Tier 3 — representation robustness
12. **Deprecate `lnglat` for compute categories** (tool round sees integer meters
    only) — structurally removes the frame-mixing bug class. *(compute agent)*
13. **Ring checksum echo** (`#verts` + bbox) in `segments_cross_polygons` output so
    truncation/miscopy is self-evident vs the legend `ext=` — an oracle-free
    self-correct signal. *(compute agent)*

**Expected composite effect of Tiers 0–2:** reading holds ~95-100; crossing
60→~80; blockage stays ≥90; mixed 50→~75-80 (enclosure already 80 via `hull=`,
road ~85, nearest-offstreet ~70). That plausibly lifts the full-suite composite
from 75.5 toward **~82-85 on haiku** — with **no new model**, all integrity-clean.

---

## v2 20B TRAINING — three defects that would sink the flagship, and the recipe

The current `sft-generate.mjs` will likely clear the *core* bands but **miss the two
things v2 is actually for** (hold-out generalization + an honest executor). Three
repo-grounded defects:

- **(A) The "2-call tool traces" bake the answer into the target.** `toolTrace()`
  puts the oracle answer inside `TOOL_RESULTS` and supervises
  `EXTRACTION…TOOL_CALLS…TOOL_RESULTS…ANSWER` as **one sequence** — so the model is
  trained to *emit the tool result itself* (hallucinated geometry at inference).
  This re-creates the v1 single-call failure. **FIX: real 2-call — split into two
  assistant segments around a real tool turn, and MASK the engine-produced
  tool-result tokens from the loss** (standard agent-SFT masking). This is the #1
  training fix.
- **(B) Paraphrases ≠ task diversity.** The 10 questions all map to the same ~10
  answer schemas; the hold-out types need *novel* schemas (count/bearing/quadrant)
  the model was never trained to emit — which is exactly why v1 hold-out was +0.
  Paraphrasing 10 tasks buys phrasing-invariance, **not** novel-schema
  generalization. **FIX: add ≥20-30 new task families / output schemas (>300 unique
  templates — the Only-IF threshold), and hold out whole *families*, not phrasings.**
  This is the make-or-break for the `hold-out ≥+5` kill criterion.
- **(C) "Disjoint seeds" ≠ disjoint geography.** Train seeds 50000+ vs eval 2000+
  still jitter within the *same ~2 km Manhattan box*, so real AOIs overlap heavily.
  **FIX: a spatial tile split** (widen jitter `*0.02→*0.10`, partition NYC into
  disjoint train/eval tiles; keep London/Phoenix eval-only). A reviewer will flag
  contamination otherwise.

**Recipe (fits the ~$66 8B / ~$99 20B budget):**
- **Traces:** real 2-call + masked tool results for compute categories; single-call
  EXTRACTION+ANSWER for read-bound (route tools only for crossing/line-int/mixed/
  blockage/enclosure — read-bound categories *regress* under a blanket tool round).
- **Diversity:** >300 templates across ~30-50 task families; keep 3-5 paraphrases
  each; 50/50 textmap2/json arms; ~35-40% carry a tool trace.
- **Vocabulary skinning:** rotate ≥5 ontology skins (FTTH/water/electric/sensor/
  logistics) + ~20% generic `node/edge/region`, holding geometry fixed — this is
  the vocabulary-invariance / domain-generality lever, ~+0 tokens. Currently absent.
- **General-instruction replay:** 5-15% high-quality generic instructions to resist
  template collapse.
- **Repair traces:** ~5%, only verifier-signal errors (bad-id/schema/frame), **no
  arithmetic self-correction** (matches our null result).
- **LoRA:** 8B → r32/α64, lr 1e-4, 2 ep, **all linear layers** (not just q/v);
  20B → r32/α64, **lr 5e-5-7e-5** (lower — overfits faster), 1-2 ep, adapters must
  cover the **expert MLPs**.
- **gpt-oss-20B pitfalls:** **Harmony format is mandatory** — reasoning
  (EXTRACTION/TOOL_CALLS) in the *analysis* channel, ANSWER in *final*; MXFP4 base +
  bf16 adapter, serve base+adapter (merge is nontrivial); verify with the
  no-system-prompt fingerprint before any eval spend.

---

## Cross-cutting integrity note (for the paper)

Every legend field above (`street=`, `served_by=`, `up=`, `terminates_in=`,
`hull=`) is a **question-agnostic structural world-fact** — the same class as the
already-frozen `inside=`, `d_closure=`, `serves=`, `feeds=`. They materialize a
*primitive/edge*, not an answer; the model still composes. The reducer ops still
compute only on model-supplied numbers/ids and never see the scene, so they cannot
leak ground truth — they reduce marshalling *volume*, not marshalling
*responsibility*. Pre-register each as a labeled artifact revision.

**Honesty caveat worth stating plainly in the paper:** the more we precompute into
the legend, the more the "read" categories become field-lookups rather than
reasoning. That's already true (`inside=`→containment, `hull=`→enclosure). Keep the
compute/compose categories (crossing, blockage, nearest-offstreet's argmin) as the
genuine reasoning tests, and be explicit about which categories test *reading of
precomputed attributes* vs *composition*.

---

## Key files to edit
- `experiments/spatial-repr-eval/core/hints.ts` — Tier-0 hint fixes (topology bug;
  add containment/onstreet/nearest; tool-mode crossing).
- `experiments/spatial-repr-eval/core/textmap.ts` (`toTextMapV2`) — Tier-1 legend
  fields (`street=`, `served_by=`, `up=`, `terminates_in=`, rename `on=`).
- `experiments/spatial-repr-eval/core/geo-tools.ts` — Tier-2 reducer ops
  (`segments_cross_polygons`, `filter_threshold`, `nearest_where`) + `GEO_TOOLS_SPEC`.
- `experiments/spatial-repr-eval/core/engine.ts` — `countToolOps`/`minToolOps`
  coverage bounds for the new ops; tool-mode hint routing.
- `experiments/spatial-repr-eval/sft-generate.mjs` — training defects A/B/C.
- `experiments/spatial-repr-eval/sft-eval.mjs` — 2-call inference loop for compute cats.

## Suggested cheap validation order (before the $200 20B)
1. Tier-0 hints + topology bug (free) → re-run the ~$3 mixed + a small full-suite
   spot check on haiku.
2. Tier-2 reducer ops + Tier-1 `street=` → re-run the ~$3 mixed (expect road ~85,
   nearest-offstreet ~70) and crossing (expect ~80).
3. Only if haiku full-suite clears ~82-85 with the new stack, fold the recipe into
   the 8B canary ($66) → then 20B ($200).

---

*Full per-agent reports with exact hint text, op signatures, and ~50 arXiv citations
are preserved in the session transcript. Every number here is an estimate from the
literature + our measured baselines; nothing above has been run except the already-
measured enclosure 60→80 (hull=) result.*
