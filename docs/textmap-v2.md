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

## Integrity boundary

Everything in v2 encodes the world, not the answers: layers, spacing, and
rulers are question-agnostic; baselines are untouched; the `verdict` arm remains
the labeled question-specific-precomputation ceiling.
