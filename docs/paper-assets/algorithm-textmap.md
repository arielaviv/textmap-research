# Algorithm 1 — toTextMapV2: Scene → engineered text map

Source of truth: `experiments/spatial-repr-eval/core/textmap.ts` (`toTextMapV2`).
This is the paper's Algorithm box, kept in sync with the code by hand — if they
diverge, the code wins.

**Input:** scene *S* = (bounds, buildings, streets, equipment, cables);
options: zoom *z* ∈ [1,2] (v2.6 labeled revision), protocol on/off (ablation).

**Output:** two aligned character grids + a measurement legend + a reading
protocol, one plain-text string.

1. **Frame.** Grid width W = 48·z; height H = clamp(W · heightM/widthM, 6,
   28·z) — aspect-preserving, north-up (row 0 = north). Affine cell mapping
   toCell(lng, lat) → (col, row); meters-per-cell mpcX, mpcY derived from
   geodesic bound lengths.
2. **LAYER 1 — GEOGRAPHY.** Rasterize streets with Bresenham ('=' where the
   segment runs mostly E-W, '|' where N-S); building footprints as '#'
   (even-odd polygon fill); inferred open margins beside buildings as ':'
   (labeled "INFERRED, NOT a surveyed sidewalk"); a building label (digits,
   then A–Z) stamped at each centroid cell. Cosmetic stamps never destroy
   semantics: a parallel `surface` grid and a per-cell building `owner` map
   record the true surface under every cell.
3. **LAYER 2 — NETWORK.** Same frame, drawn on an EMPTY field: CO '*',
   cabinets '@', closures 'a'–'z', cable paths '-', '|', '/', '\\' —
   unoccluded, so the full position/path is visible even where it overlaps
   geography. This is the v2 fix for v1's occlusion failure (one canvas
   overwrote exactly the evidence containment/crossing questions need).
4. **Tokenization discipline.** One single-byte code point per cell,
   space-separated, so BPE keeps one token per cell (v1's run-merging
   destroyed column identity); col/row rulers on the edges align 1:1 with
   content.
5. **GRID REF.** One affine anchor line — "cell(col,row) centre = [lng,
   lat]" with per-cell deltas — so any cell maps back to world coordinates.
6. **LEGEND — the precision layer, keyed by REAL scene ids.** Per building:
   marker, (col,row), x/y meters from the SW corner, address. Per equipment:
   marker, (col,row), x/y m, kind, `serves=` list, `on=` street, `near=`
   address, `inside=` building (exact point-in-polygon, precomputed),
   `d_street=` meters (exact point-to-polyline). Per named street: id, name,
   orientation (unnamed "street N" placeholders excluded). CABLES: id, kind,
   source → target, endpoint cells. Every measurement is exact geodesic
   (haversine) — never read off the raster; the model never has to count
   cells for a precise answer.
7. **READING PROTOCOL** (stripped by the `protocol=false` ablation):
   (a) cross-reference rule — the layers share coordinates; equipment over
   '#' sits INSIDE that building; a cable glyph over '#' crosses it UNLESS
   that building is the cable's own source/target; (b) a worked hypothetical
   example (marked "NOT from this scene"); (c) GEOMETRY vs TOPOLOGY — grids
   say where, the legend's `serves=`/CABLES say who connects; for
   connectivity questions read the legend, do not trace glyphs;
   (d) THRESHOLDS — numeric comparisons use the legend's measurements, not
   cell counts.

**Integrity invariant:** the artifact encodes the *world*, never answers —
every legend field is question-agnostic (a property of the scene, computable
before any question exists); baseline formats are untouched; the `verdict`
arm remains the labeled question-specific-precomputation ceiling.

**Ablation map:** v1 single-layer grid (occlusion baseline, frozen) ·
v2 − protocol (`protocol=false`: same data, no reading rules) ·
v2.6 zoom z=2 (resolution vs tokens) · JSON / WKT / rendered-image baselines.
