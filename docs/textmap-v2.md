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

## Integrity boundary

Everything in v2 encodes the world, not the answers: layers, spacing, and
rulers are question-agnostic; baselines are untouched; the `verdict` arm remains
the labeled question-specific-precomputation ceiling.
