# textmap v2 — design & pre-registered predictions

Written **before** any eval run of the `textmap2` arm (July 8, 2026). The v1
renderer is frozen as the ablation baseline; v2 shares its legend byte-for-byte,
so the `textmap` vs `textmap2` comparison isolates pure grid design.

## Why naive ASCII grids fail LLMs

- **F1 Occlusion.** A single canvas overwrites: an equipment glyph replaces the
  `#` beneath it, and v1 never draws cables through buildings. The render
  destroys exactly the evidence containment/crossing questions need.
- **F2 Tokenization.** BPE merges runs (`....####....` → 3–4 opaque tokens);
  column identity is destroyed before the model reads it (cf. models playing
  chess better from FEN than ASCII boards).
- **F3 Positional arithmetic.** "One cell up" is ~50 characters back in a 1D
  stream; column counting is character-level reasoning, a known LLM weakness.

## Design principles

| # | Principle | Mechanism | Targets |
|---|---|---|---|
| P1 | Lossless at query time — rendering never destroys a spatial fact | Two ALIGNED layers (geography / network), network drawn unoccluded | F1 |
| P2 | Tokenizer-aligned — one cell ↔ one stable token | Space-separated cells | F2 |
| P3 | Self-locating — no line requires counting | Column rulers, row numbers on both margins, `GRID REF` affine line | F3 |
| P4 | Dual-coded — gestalt + precision share one frame and the answer id namespace | Grid + legend (exact col/row, meters, relations, real ids) | — |

v1 already implements P3 + P4; **v2 adds P1 + P2** and directional cable glyphs
(`- | / \`). Cross-layer lookup is taught in the header: an equipment marker
over `#` in LAYER 1 sits INSIDE that building; a cable glyph over `#` crosses it.

## Pre-registered predictions (falsifiable)

- **H1 (mechanism-targeted):** v2 > v1 on *containment* and *crossing*
  specifically (the occlusion fix); ≈ v1 on nearest/coverage/path (legend-carried).
- **H2:** v2 ≥ v1 on blockage/enclosure (directional glyphs + clean layers).
- **H3:** the textmap family dominates the accuracy-per-input-token frontier vs
  json/wkt, with the gap widening with AOI scale (fixed-size grid + linear
  legend vs linear-in-vertices coordinates).
- **H4:** the representation effect is largest for the cheapest models.
- **Cost:** v2 grid ≈ 4× v1's grid tokens (2 layers × spacing) — still well
  below the json arm at every scale level.

## v2.1 amendment — materialized joins (logged before its first run)

Motivated by the first 40-call probe (July 8): single-shot forced answers leave
no room to *execute* the cross-layer procedure — Haiku performed the lookup
correctly in interactive chat but not one-shot. v2.1 therefore:

- adds `under=` to every equipment legend row — the LAYER 1 surface at the
  entity's own cell (`#(B-x)` / `=` / `|` / `:` / `.`), computed at render time
  from the same two layers (a materialized join, entity-local, question-agnostic);
- adds a HOW-TO-READ header line with a *hypothetical* worked example (never
  computed from the scene — that would leak an answer).

This places v2.1 explicitly on the **precomputation dial**:
`json → grid+legend (v2) → +materialized joins (v2.1) → predicates (verdict)`.
Entity-local facts go in; global scans (e.g. enumerating cable crossings) stay
out — that is the verdict arm's side of the line.

**Prediction (pre-run):** containment flips to correct for textmap2 in
single-shot mode; `onstreet` may improve (`under==`). Known risk: `under=` is
cell-quantized (~7m at 350m scale) while the oracle uses exact geometry — edge
cases can disagree; quantization error is reported honestly, not hidden.

**Iteration log (July 8, run 2, 20 calls):** the quantization risk fired — the
raster-derived `under=` produced 3/9 false positives (closures hugging a wall
land in cells whose centers fall inside the footprint); the model followed the
legend faithfully and was graded wrong. Fix: `under=` is now computed from
EXACT geometry (pointInPolygon on the true position), consistent with the
legend's existing exact-geometry `on=` field; the raster char remains only as
the non-building fallback. Also added `d_street=` (exact distance to nearest
street centerline) — a raw *measurement*, not a judgment; the boundary to the
verdict arm is measurements-vs-predicates plus entity-local-vs-global-scan.
**Prediction (pre-run 3):** containment, onstreet, and road_misplacement flip
for textmap2; blockage/enclosure remain grid-procedural and likely still fail
one-shot on haiku.

**Run 3 (20 calls):** textmap2 7/10 vs json 4/10 — containment ✓ and onstreet ✓
flipped as predicted; road_misplacement did NOT (model answered `[]`).
Root cause was a QUESTION defect, not a representation defect: the oracle grades
"in road" at ≤3m but the prompt never stated the threshold (unlike onstreet's
"~8m") — no arm can know the grader's cutoff, and every arm failed it. Fixed
the prompt for ALL arms equally (threshold now quoted from `ORACLE_CONSTANTS`).
Principle recorded: **a question must carry its own judgment criterion**, or it
tests threshold-guessing rather than spatial reading.
**Prediction (pre-run 4):** road_misplacement flips for textmap2 (reads
`d_street=`); json likely still fails it (must derive 9 point-to-polyline
distances from raw coordinates one-shot).

**Run 4 (2 calls, targeted):** still wrong — textmap2 answered the three
closures whose CELLS are street cells; the oracle wanted all eight at ≤3m.
Deeper defect: the synthetic generator places every closure at exactly 3.0m
offset, so the ≤3m oracle made the entire roster "in road" by boundary
equality — the question degenerated into float-threshold trivia. Fix:
`IN_ROAD_M` 3→2 (prompt auto-syncs via `ORACLE_CONSTANTS`), so "in road" means
the genuinely misplaced closure (the planted one at 0.0m). Applies to every arm
equally. **Prediction (pre-run 5):** textmap2 answers exactly the d_street=0.0
closure; json must find it from raw coordinates and likely fails.

**Run 5 (20 calls):** textmap2 **8/10** vs json 4/10 — road_misplacement
flipped as predicted. Remaining failures (blockage, enclosure) fail on BOTH
arms. Sonnet spot-check (4 calls): sonnet+textmap2 solves blockage where
sonnet+json does not (the model-tier × representation interaction, H4);
enclosure still fails everywhere — and inspection shows BOTH models answer the
geometrically-correct `B-1-1` while the oracle listed 5 buildings: on a regular
grid the edge-midpoint centroids are COLLINEAR with the corners, and
monotone-chain hulls drop collinear points, so the oracle mislabeled
visually-perimeter buildings as interior. Oracle fixed: perimeter = centroid on
the hull BOUNDARY (≤1m), not hull-vertex membership. Selftest 9/9 after fix.
**Prediction (pre-run 6):** enclosure flips for BOTH arms (their answers were
already correct).

**Runs 6–8:** enclosure oracle fix confirmed (sonnet answers B-1-1 on both
arms = correct now); haiku answers `[]` on both — a genuine capability floor,
not a representation issue. One more representation defect found and fixed:
`under=` mixed provenances (raster street-cell vs exact d_street) and the two
fields could contradict each other in one row — sonnet followed the raster char
and over-answered. All `under=` facts now derive from exact geometry only
(`=` means d_street ≤ 1m). **Final single-scene scoreboard (isolate, seed 42):**

| model | json | textmap2 |
|---|---|---|
| haiku-4.5 | 4/10 | **8/10** |
| sonnet-4.6 | 8/10 | **9/10** (blockage solved on grid only) |

Consistent with H4: the representation buys the most for the cheapest model
(haiku+textmap2 = sonnet+json), and the residual haiku failures
(blockage, enclosure) are procedural-geometry questions that sonnet solves.
Caveats: one scene, one repeat — the full 20-map run turns this into
statistics; v2 costs ~55% more input tokens than json on small synthetic
scenes (the token win is scale-conditional).

## v2.2 amendment — after the first full 20-map real run (haiku, 1,200 calls)

**Result: exact tie, 40.2% vs 40.2% — the synthetic win did NOT transfer.**
Category split: textmap2 dominated entity-local categories (containment 95% vs
58%, on-street 100% vs 50%) but collapsed on crossing (5% vs 45%) and path
(60% vs 100%), cancelling out. Run-log inspection showed both collapses were
DOCUMENTATION defects in the representation's own header:

- crossing: the CROSS-REFERENCE rule said "cable glyph over '#' crosses it"
  with no own-terminal exclusion — drops end INSIDE the building they serve, so
  the model faithfully reported its own drop cables. Rule now states the
  exclusion and points at CABLES source -> target.
- path: the model TRACED the drawn glyphs across the grid instead of reading
  `serves=` — nothing said the grid is geometry while topology lives in the
  legend. New GEOMETRY vs TOPOLOGY header line.
- scene fix (all arms equally): real scenes snapped EVERY closure onto the
  centerline, making road_misplacement degenerate (the whole roster ≤2m).
  Closures now sit ~4m off-centerline toward their building (sidewalk); only
  the planted closureOnStreet stays at 0m.

**Prediction (pre-run, v2.2 haiku 20-map):** crossing recovers to ≥ json,
path recovers to ~100% (legend read), road_misplacement becomes meaningful and
textmap2 wins it via d_street; overall textmap2 breaks the tie decisively while
json stays ~40%.

**Run (v2.2 haiku 20-map ×3 repeats):** textmap2 44.3% vs json 37.5%
(McNemar b=72 c=113, p=0.0033 — BUT repeats at temp 0 are near-identical, so
the effective n is ~200 unique items and the honest p is weaker). Path
recovered to 95%; mixed 35% vs 1.7%; containment 83% vs 15%. crossing did NOT
recover (10% — raster over-approximation of line-polygon intersection at 4–5m
cells; candidate fundamental limitation). on-street REGRESSED to 25%: sidewalk
closures at ~4m get `under=:` while the ~8m question threshold makes them
on-street — the categorical label out-competed the d_street measurement.

## v2.3 amendment + statistics fix (overnight program, $50 cap)

- New THRESHOLDS header rule: numeric distances in questions compare against
  legend measurements; categorical labels are not distance judgments.
  (Targets the on-street regression.)
- Statistics fix: repeats at temperature 0 are correlated, so significance now
  comes from 60 DISTINCT maps × 1 repeat (real-scene n cap raised 30→60).

**Probe (8 scenes, on-street only):** the THRESHOLDS rule alone FAILED (3/8) —
the categorical `under=:` label kept out-competing the d_street number. Fix:
**labels lost their vote** — `under=` replaced by `inside=B-x|none` (building
containment only, its one real job); street-ness is now conveyed ONLY by the
d_street measurement. Re-probe: on-street 7/8, containment 7/8,
road_misplacement 6/8. Design principle recorded: **when a categorical label
and a measurement describe the same fact, the label wins the model's attention
— so a legend should carry each fact exactly once, as a measurement.**

**Prediction (pre-run, 60-map haiku, v2.3 frozen):** on-street recovers to
≥80%; overall textmap2 ≥ +6 points over json with McNemar p < 0.05 on
uncorrelated items; crossing stays weak (~10–20%) pending a structural idea.

## Certification + ablation (overnight, July 8–9)

**CERTIFIED (60 distinct real maps × 1 repeat, haiku, isolate):**
textmap2 47.0% vs json 38.7% — McNemar b=108 c=58, χ²=14.46, **p=0.0001** on
uncorrelated items. This is the paper's headline statistic.

**Protocol ablation (20 maps, textmap2 vs textmap2np=headers stripped):**
overall a wash (46.5% vs 45.0%, p=0.71) — but category-level it decomposes:
geometry-vs-topology line +35 points on path (90% vs 55%), +10 containment;
THRESHOLDS line −15 on-street / −8 mixed (it patched a conflict the `inside=`
data fix had already removed — leftover teaching prose became noise).
**v2.4 = drop THRESHOLDS, keep the other three lines.** Probe (12 scenes):
on-street 10/12, path 12/12 — accepted and frozen. Lesson: **protocol lines
earn their place per-line; hints that outlive the defect they patched turn
into noise.**

## Overnight results (July 9, v2.4 frozen)

- **Sonnet matrix (20 maps):** textmap2 **56.5%** vs json **38.5%** —
  χ²=19.76, p<0.0001. Crucial twist: sonnet's json score EQUALS haiku's
  (38.5 vs 38.7) — model capability contributes nothing through raw geometry;
  it compounds only through the readable representation (47.0 → 56.5).
  The representation is the bottleneck, not the model.
- **Scale sweep (3 centers × 4 sizes, haiku):** accuracy equal-or-better at
  every size while tokens diverge — json 9.5k→18.4k vs textmap2 6.7k→9.7k
  (47% cheaper at 2800m, equal accuracy). Representation size ratio widens
  1.48×→2.15× (free char measurement, results/scale-sizes/).
- **Related-work calibration:** ASCII-grid literature (Text2Space, GRASP,
  PlanarBench) finds naive ASCII loses to JSON coordinates — consistent with
  our v1 tie; our claim is what it takes for a text map to WIN (dual coding +
  exact measurements + per-line-validated protocol). Geospatial benchmarks
  (GPSBench, MapEval, GS-QA, GeoBenchX) evaluate ON GeoJSON; none engineer an
  alternative representation with token economics on real maps.
- Budget: ~$27 of the $50 cap spent; ~$22 left in the account as reserve.

## v2.5 — the last height iteration (July 9 morning), then freeze

Added `d_closure=` per building (exact distance to nearest closure — distance
only, never the id; completes measurement symmetry). Probe: nearest 12/12;
coverage UNCHANGED (3/12). Diagnosis from raw answers: every d_closure in the
legend was under 35m (7.6–20.1m), oracle = "none" — and haiku still named the
LARGEST-distance buildings. The information is trivially present; the model
cannot answer "empty set" (affirmation bias on existence questions). Controls:
sonnet coverage 60% (no such bias), verdict ceiling 90%. **Finding #6:
representation engineering ends where answer calibration begins — information
access and answer bias are separable failure modes, and our harness separates
them.** Validation (20 maps): v2.5 50.0% overall, no regression, nearest 100%.

**FROZEN at v2.5.** Remaining iterations are breadth, not height: hold-out
question set (the overfitting objection), second city (morphology
generalization), gateway vendors. Certified paper numbers remain the v2.4
60-map run; v2.5 differs only by the additive d_closure field (validated
regression-free).

## Spatial spread caveat — the 60 maps are one neighborhood, and they overlap

Logged July 12 while auditing the generalization claim. `aoiForCity` (real-scene.ts:314)
jitters the AOI center by the seed with a `* 0.02` factor = **±0.01°**. In NYC that
is ±1.1 km N–S and ±0.84 km E–W, so the 60 certification seeds scatter their
centers inside a **~2.2 × 1.7 km box** around one Manhattan center. Each map is a
350 m window. Two consequences a reviewer will (correctly) raise:

1. **One neighborhood, not "across NYC."** All 60 share Manhattan's dense regular
   grid morphology. The honest paper phrasing is "distinct blocks within one
   Manhattan neighborhood," not "maps." This is the same limitation as
   single-city, sharpened — and the second-city run is what earns the word "maps."
2. **Heavy overlap → weakened inter-trial independence.** The window (350 m) is far
   larger than the center spacing (~17–22 m lattice over the 2 km box), so
   neighboring maps share most of their area and the same buildings recur across
   many maps. McNemar's *pairing* (textmap vs GeoJSON on the same map) is still
   valid — that is all the test needs — but effective sample diversity is below
   the nominal n=60. State this; do not lean on "60 independent maps."

**Cheap fix, queued with the budget-gated runs (no code shipped yet):** widen the
jitter (e.g. `* 0.10` → ~10 km box) so the 350 m windows stop overlapping, giving
genuinely independent, non-overlapping blocks *within* NYC; combine with a second,
morphologically different city (curved/irregular streets) to cover both "different
neighborhood" and "different morphology" in one run. One-line change to the `* 0.02`
factor plus a `CITY_CENTERS` entry.

## Hold-out question set — pre-registered 2026-07-15, BEFORE first run

The overfitting control. Six NEW question types (`ho_*`, category `holdout`),
written after the v2.5 freeze; none was ever run during representation
iteration. Opt-in via questionIds so the frozen 10-question protocol is
untouched. Deterministic target pickers with margin guards (≥25%/10m distance
gap, maximal-margin bearing, ≥15% midpoint uniqueness, argmax-set quadrant
ties) per lesson #3. Plan: run ONCE on the 60 certification scenes (seeds
1000–1059), json + textmap2, haiku, report as-is — no post-hoc iteration.

**Predictions (falsifiable, logged before the run):**

1. **Overall: textmap2 > json on the hold-out set, but by a NARROWER margin
   than the tuned set's +8.3** (predicted +3 to +8). Some of the tuned-set gap
   reflects question–format co-design; the honest expectation is partial
   transfer, not full.
2. Per question:
   - `ho_count_inside`: textmap large win (legend `inside=` rows carry it;
     json must run point-in-polygon per item). Disclosed: counting-inside
     re-tests a tuned capability in a new answer form.
   - `ho_closer`: json wins or tie (exact coords → precise pairwise distance;
     the grid quantizes to ~4–5m cells).
   - `ho_bearing`: textmap modest win (rulers make north/south a glance).
   - `ho_midpoint`: json slight edge (pure coordinate arithmetic).
   - `ho_quadrant`: textmap large win (density gestalt; json must bin 12+
     centroids by hand).
   - `ho_rank3`: json wins (exact top-3 ordering is arithmetic; cell
     quantization can swap near-equal ranks 2/3).
3. **Kill criterion:** if json ≥ textmap2 overall on the hold-out set, the
   certified result must be reported as benchmark-specific and the paper's
   claim narrowed accordingly. That is what this run is for.

**RESULT (2026-07-15, results/holdout-haiku, run once, no iteration):**
textmap2 48.3% vs json 43.1% — **+5.2, inside the pre-registered +3..+8 band**;
McNemar b=52/c=33, χ²=3.81, **p=0.051** (boundary — reported as-is; the
hold-out is the transfer control, the certified tuned-set run remains the
headline). Per-question: 5/6 directional predictions correct — count_inside
38/10 (textmap, predicted), closer 97/95 (tie, predicted), bearing 90/85
(textmap, predicted), midpoint 15/25 (json, predicted), quadrant 40/33
(textmap, predicted direction, smaller magnitude), rank3 10/10 (predicted
json win; both at floor — ordered-triple exactness is hard for haiku in any
format). Kill criterion NOT triggered. Token advantage persists (6.9k vs
10.1k avg in). Zero errors.

## Second city — London (2026-07-15, results/certify-london, run once)

Morphology generalization + the overlap fix in one run: irregular pre-modern
street network (Soho/Covent Garden, ~60 street segments per scene vs
Manhattan's ~18), doubled jitter so the 60 windows are mostly non-overlapping.
**textmap2 46.7% vs json 42.2% — +4.5, McNemar b=79/c=52, χ²=5.16, p=0.023.**
The certified NYC gap (+8.3) does not fully transfer but the advantage is
present and significant on unseen morphology. Tokens 6.8k vs 10.4k. Honest
notes: coverage FLIPPED (tm 20% vs json 45% — the 35m gap-scan degrades on
London's cluttered grid; report as a morphology-sensitive weakness);
textmap hallucinated-id rate 2.7% (vs 0.8% NYC) — denser glyph field.
Cross-city summary: NYC +8.3 (p=0.0001), London +4.5 (p=0.023), hold-out
questions +5.2 (p=0.051) — three independent tests, one direction.

## Cross-vendor matrix (2026-07-15, results/matrix-vendors, 20 maps each)

Pooled: textmap2 46.8% vs json 35.6% — +11.2, McNemar b=137/c=48, χ²=41.86,
p<0.0001, zero errors. Per model: Gemini 2.5 Pro +19.0 (54.5/35.5), Grok 4.1
fast +17.5 (47.5/30.0), DeepSeek v3.2 +15.0 (53.5/38.5) — all LARGER than
haiku's +8.3 — and one exception: **Qwen-3-235B −7.0 (31.5/38.5)**. Diagnosis
from per-question rows: Qwen's loss concentrates in topology (5/20 textmap vs
18/20 json) and it hallucinates ids at 18.5% on textmap (others ~0%) — it
traces glyphs instead of reading the legend's serves= topology, i.e. it does
NOT follow the reading protocol. Finding #7: **the engineered representation
transfers across 3 of 4 vendors with larger gains than Anthropic's ladder;
protocol-following itself is model-dependent** (per-model protocol
calibration = future work). The bottleneck result is now cross-vendor: raw
GeoJSON reading sits at 30–38.5% for EVERY model tested (7 models, 4 labs).

## GeoFM Task-1 external validation — pre-registered 2026-07-15, BEFORE first run

Replicating GeoFM (arXiv 2505.17136) Task 1 on THEIR data: their 1,400-triplet
test split (recovered from their published task1_results_all.csv; their GPT-4
zero-shot 0.628 / few-shot 0.661 / GPT-3.5 zero-shot 0.369 reproduce exactly
from their per-item outputs), their verbatim zero-shot prompt, their
normalization and full-triple grading. One variable: WKT strings vs the same
two geometries drawn as two aligned grid layers (grid + GRID REF only — NO
measurements anywhere; a distance would leak the DE-9IM answer).

**Predictions (falsifiable, before the run):**
1. textmap > wkt overall on haiku (the grid makes within/contains/overlaps
   VISIBLE; WKT demands vertex arithmetic haiku can't do).
2. Per predicate: textmap large win on within/contains/overlaps/disjoint
   (containment gestalt); textmap WEAK on touches vs crosses disambiguation
   (boundary-vs-interior at 44×26 cell resolution — our known raster
   limitation) and on equals (their manufactured equals pairs interpolate
   extra vertices; these rasterize IDENTICALLY, so grid-equals should be
   readable — but so is coordinate comparison; predict small textmap win).
3. Both arms likely below their GPT-4 numbers (haiku ≪ GPT-4); the claim
   under test is the REPRESENTATION delta on an external benchmark, not
   beating GPT-4.
4. Kill criterion: wkt ≥ textmap overall ⇒ report as-is; the textmap's
   scene-reading advantage does not extend to bare geometry-pair topology,
   and the paper's external-validation section says so.

**RESULT (2026-07-15, results/geofm-task1, run once, no iteration):**
wkt 58.9% vs textmap 56.6% — **kill criterion INVOKED**: on bare pair
topology the textmap does NOT beat raw WKT overall. Per-predicate (vs
predictions): textmap DOMINATES disjoint **97 vs 76** and equals **92 vs 81**
(gestalt-visible topology — predicted for disjoint, predicted small for
equals); COLLAPSES on contains **18 vs 59** (prediction WRONG — collinear
LineString containment rasterizes container and contained onto the same
cells; sub-cell precision is exactly what pair topology needs); touches
34 vs 42 and crosses 22 vs 25 weak both arms (predicted). Prediction 1
(textmap > wkt overall) FALSIFIED; predictions 2 partially right, 3 right,
4 honored. Paper framing: **the textmap is a scene-reading representation;
its advantage does not extend to pair-level geometric decisions at raster
resolution — this defines the method's boundary**, with two notable
inversions (disjoint/equals) where topology IS gestalt-visible. Side
finding: haiku-2026 + raw WKT (58.9) ≈ GPT-4-2024 zero-shot (62.8) on
their benchmark. Cost $7.59, zero errors, 2,800 calls.

## Hints / voting / turns program — pre-registered mock, 2026-07-15, BEFORE build+run

Conditions: B baseline (measured) · H +hints · P full pipeline (hints +
majority voting K=5 @ temp 0.7 + self-correction ≤5 turns). The correction
loop terminates on VERIFIER PASS (id-existence + schema + self-consistency),
NEVER on oracle agreement — looping "until correct" would leak ground truth;
OptiMind's loop used executable solver feedback, ours uses representation-
legal signals only (disclosed design difference).

Predicted (our benchmark, accuracy %):
- Haiku: json 38.7→41(H)→44(P); textmap 47.0→54(H)→60(P); wkt 36.5→41(P); image 18.7→21(P)
- Sonnet: json 38.5→42→45; textmap 56.5→62→67
- Opus: json 34.5→38→42; textmap 64.5→68→73
- GPT-5-mini: json 37.5→40→44; textmap 47.5→54→60
- Gemini: json 35.5→39→43; textmap 54.5→60→66; wkt 27.5→32(P); image 7.0→9(P)
- DeepSeek: json 38.5→41→44; textmap 53.5→59→64
- Grok: json 30.0→33→36; textmap 47.5→53→58
- Qwen: json 38.5→40→42; textmap 31.5→45(H!)→50 — widest bars; hints ARE
  explicit protocol, its failure is protocol-refusal
- Kimi (no baseline yet): json ~35→38→41; textmap ~48→54→59
- GeoFM: wkt 58.9→61-62(H); textmap 56.6→62-64(H) — loss predicted to flip

Falsifiable headline predictions:
1. hint-delta(textmap) ≈ 2× hint-delta(json): hints fix reading HABITS,
   not computation ability.
2. Image barely moves under P (+2-3): scaffolding rescues reading, not
   perception (identity loss).
3. The representation gap SURVIVES the pipeline: P-json < B-textmap on
   haiku. If falsified → claim narrows to "representation OR scaffolding".
4. Voting alone ≤ +2 (bias ≠ noise); turns ≤ +3 (verifier signals are weak
   vs executable feedback).
SFT (paper 2) predictions: base-8B json 25-32 / textmap 30-38; SFT-8B
textmap 55-65 (rivals frontier-on-geojson), SFT-8B json 38-45. Risk
disclosed: SFT may partially close the format gap.
Vocabulary probe DROPPED (user decision: closures stay).

## Booster screening — pre-registered 2026-07-16, BEFORE the probe

8 conditions on the same 20 scenes (seed 1000), haiku, textmap2 arm,
hints as base + power set of {Scan, Citations, Zoom×1.5}. 20-map textmap2
baseline (no hints) = 46.0. Predictions:
- H alone: 52 (±3) — coverage + crossing hints carry it
- H+S: +3..5 over H (self-built verdict layer; the extraction-gap thesis)
- H+C: +1..2 over H; main effect = hallucination ↓
- H+Z: +1..3 (crossing/blockage only; tokens +~50% — the cost is the story)
- Combos ≈ additive minus overlap; H+SCZ ≈ 58-62
- Selection rule (BINDING): a booster survives to the $200 program iff its
  marginal gain ≥ +3 points in at least one combination; survivors join P.
  AMENDED 2026-07-16, mid-screening (after H/HS/HC, before the full table),
  by author decision: final selection deferred to post-data review — small
  gains may be kept if they stack. Amendment logged before full data.
- Scan asymmetry check: winner condition re-run on json arm — predicted
  near-zero gain there (extraction ≠ computation).
Zoom is v2.6 — a LABELED artifact revision, reported separately from the
frozen v2.5 baseline. Cost ≈ $20 of the $25 charge.

**RESULTS (2026-07-16, 20 maps each, n=200, baseline 46.0):**
H 48.0 · HC 49.0 · HCZ 49.5 · HZ 52.0 · HSZ 53.0 · HSC 53.5 · HS 54.0 ·
**HSCZ 56.0 (+10)**. Marginal effects: **Scan avg +4.5** (positive in all 4
on/off pairs — the extraction-gap thesis measured), Zoom avg +1.5 (mixed),
Citations avg +0.3 (noise on accuracy). Hints alone +2.0 (below the
predicted 52±3 band — prediction MISSED; hints are a foundation, not the
engine). Token cost of the stack ≈ 2.3× baseline (HSC: 13.9k in / 975 out
per item). Incident 4: citations induced a string-for-array schema
violation that 500'd a run — answers now type-coerced at ingestion, grading
crash-proofed per item.

**Few-shot addendum (GeoFM-proven booster; user-directed):** miniature
synthetic worked example (seed 999, never in tests), oracle-answered,
arm-format-faithful. Conditions HF / HSF / HSCZF fired 2026-07-16.
Predictions REGISTERED WHILE RUNS IN FLIGHT (before any result seen —
disclosed): HF 53±3 (+5 over H); HSF ≈ HS+2..4 (overlap: both teach
reading); HSCZF 58-62 (new best). If HSCZF < HSCZ, few-shot's example
interferes with scan's own extraction — report either way.

**FEW-SHOT RESULTS: HF 49.0 (+1 over H — prediction MISSED), HSF 51.0
(−3 vs HS), HSCZF 50.0 (−6 vs HSCZ). DROPPED.** The interference case
happened: the miniature worked example anchors extraction on a 2-building
toy and shallows the scan of a 12-building scene. Negative result kept for
the paper: GeoFM's few-shot gain (0.628→0.661 on geometry pairs) does NOT
transfer to scene-scale reading. Two prediction misses today (H alone,
few-shot) — both logged.

**Final screen (fired 2026-07-16, pre-registered): HSCZ + votes 5 +
turns 5 = the complete pipeline P on the same 20 maps.** Prediction:
58-61 (voting +1-2 over HSCZ — bias dominates noise; turns +1-2 via
hallucination bounce-backs). Token cost ≈ 10× baseline — the accuracy/cost
frontier IS the finding.

## Routed pipeline validation — pre-registered 2026-07-16, BEFORE the run

Screening discovery: scan TRANSFORMS coverage (20→95) and containment
(75→95) but DESTROYS path (90→15) and dents on-street (85→75) — its spatial
extraction overrides the read-serves=-don't-trace rule. One pipeline cannot
win both; ROUTE by question type (legitimate: keyed on the question, known
at ask time — OptiMind routes by problem class identically).

Routing: HSCZ for containment/crossing/coverage/nearest/line-intersection/
mixed (8 questions); H-only for path/on-street (2 questions). Screening
composite (same-maps, selection-biased): 65.0. **Validation on FRESH seeds
2000-2019 (never used anywhere). Prediction: composite 58-63** (regression
toward the mean expected; anything ≥58 confirms routing beats every single
recipe; ≥61.5 beats haiku's verdict ceiling). Cost ≈ $6.

**RESULT (2026-07-16, results/routed-A + routed-B, fresh seeds, run once):**
Run A 55.6% (n=160), Run B 85.0% (n=40) → **composite 61.5% — prediction
band HIT (58-63), equals haiku's verdict ceiling (61.5), +15.5 over the
46.0 certified-slice baseline.** The routed pipeline is the final recipe:
haiku + textmap + routed{hints+scan+cit+zoom | hints-only} reaches the
accuracy of haiku WITH ANSWERS PRECOMPUTED — the pipeline recovers the
entire extraction gap. Caveat for the paper: single-recipe numbers were
measured on the screening seeds; a same-seeds HSCZ control on 2000-2019
(~$5) would make the routed-vs-flat comparison map-identical (queued for
the scale-up). Next pipeline idea (pre-registered before any test):
category-aware scan — the scan prompt itself routes (topology questions
extract serves=/cable links instead of spatial facts); predicted to lift
path inside the scan stack toward its 85-90 hints-only level.

## Category-aware scan validation — pre-registered 2026-07-16, BEFORE the run

Implements the idea pre-registered above: instead of ROUTING around scan for
path/on-street, the scan's extraction brief itself becomes category-aware, so
ONE recipe covers all 10 questions. Gated behind `--scan-targets` (the generic
scan stays runnable as a control). Exact templates (engine.ts `SCAN_TARGETS`),
quoted verbatim so the record predates the run:

- **path**: "extract the CONNECTIVITY GRAPH only: one line per equipment entry
  with its exact id and the full list of building/equipment ids it serves,
  exactly as written; one line per cable with its exact id and its two
  endpoints (source → target). Do NOT extract positions, distances or streets —
  this question is answered purely by connectivity."
- **on-street**: "extract the STREET-PLACEMENT facts only: one line per
  equipment entry with its exact id and every fact the representation states
  about its position relative to streets (the street it sits on, its distance
  to the nearest street, or its coordinates if that is all the representation
  provides). Do NOT extract serves lists or buildings."

Disclosed addendum: the original stub named only topology; the on-street
template is added here, still before any call. Wording is representation-
neutral (names fields, never scene values); grader untouched; no ground truth
enters the prompt.

**Design (fresh seeds 2000-2019, haiku, textmap2 isolate, temp 0):**
- Run CAT (`results/catscan-fresh`): HSCZ + scan-targets, all 10 questions,
  n=200 items. The 8 non-overridden categories are prompt-identical to routed
  Run A → free same-seed replicate of Run A.
- Run CTL (`results/scanctl-fresh`): HSCZ generic scan, ONLY topology+onstreet,
  n=40 items → same-seed head-to-head for the 2 changed categories, and
  (combined with CAT's 8-cat slice) the queued single-recipe HSCZ control on
  fresh seeds at no extra cost.

**Predictions:** CAT path 70-90 (kill: <50 ⇒ category targets fail, routing
stays the recipe); CAT on-street 80-90; CAT composite 58-64; CAT 8-cat slice
52-59 (replicating Run A 55.6); CTL path <40 (the collapse replicates on fresh
seeds — if it does NOT, the routing/cat-scan justification weakens and we say
so). **Decision rule:** the scale-up recipe = CAT if its composite ≥ routed
61.5 − 2pts (one pipeline beats two on simplicity); else routed. Cost ≈ $6.

## Integrity boundary

Everything in v2 encodes the world, not the answers: layers, spacing, and
rulers are question-agnostic; baselines are untouched; the `verdict` arm remains
the labeled question-specific-precomputation ceiling.
