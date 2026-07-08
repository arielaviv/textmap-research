# Paper skeleton — "Engineering Text Maps: How LLMs Actually Read Space"

Working title options:
- *TextMap: Engineered Text Representations Beat Raw Geometry for LLM Map Reasoning*
- *The Representation Is the Bottleneck: Text Maps for LLM Spatial Reasoning*

## 1. Introduction
- LLMs increasingly operate on geospatial data (agents over GIS stores), which
  arrives as raw geometry (GeoJSON/WKT). Do models read it well? No — and
  scaling the model does not help (headline: sonnet gains ZERO over haiku on
  raw GeoJSON, 38.5% vs 38.7%).
- Contribution: an engineered text representation (layered grid + measurement
  legend + reading protocol), four design principles, and an oracle-graded
  eval on real OpenStreetMap scenes showing +8.3 (haiku) and +18 (sonnet)
  accuracy at up to 47% fewer tokens. McNemar p=0.0001 / p<0.0001.

## 2. Related work (calibrated against tonight's sweep)
- ASCII/grid spatial benchmarks: Text2Space, GRASP, PlanarBench, "Learning to
  Draw ASCII improves spatial reasoning" — consistent finding: naive ASCII
  layouts LOSE to Cartesian/JSON coordinates. We agree — our v1 tied json and
  the grid-only ablation is expected to lose; the contribution is what it
  takes for a text map to WIN (dual coding + exact measurements + protocol).
- Geospatial LLM benchmarks (GeoJSON topological relations, GPSBench, MapEval,
  GS-QA, GeoBenchX): evaluate models ON standard formats; none engineer and
  ablate an alternative representation with token economics on real maps.
- OptiMind (arXiv 2509.22979): error-analysis-derived hints injected at
  inference for NL→MILP. We transplant the idea INTO the artifact (the
  representation ships its reading protocol) and measure it as a component.

## 3. Method: the textmap
- Four principles: P1 lossless-at-query-time (aligned layers, unoccluded);
  P2 tokenizer-aligned (one token per cell); P3 self-locating (rulers, GRID
  REF affine); P4 dual-coded (grid gestalt + measurement legend sharing the
  answer id namespace). Plus the reading protocol (3 lines, each earning its
  place by ablation).
- The precomputation dial: raw geometry → grid+legend → +entity-local
  measurements (inside=, d_street=) → question-specific predicates (verdict
  arm = declared ceiling/control). Boundary: entity-local measurements in,
  global-scan judgments out.
- Iteration methodology: probe (≈10 calls) → validate (20 maps) → certify
  (60 maps); every change pre-registered (docs/textmap-v2.md is the log).

## 4. Experimental setup
- 60 real Manhattan scenes (OSM), 10 oracle-graded questions across 8
  categories, forced structured answers, isolate mode (each arm sees ONLY its
  representation), temperature 0, 1 repeat (repeats at temp 0 are correlated —
  reported and avoided).
- Metrics: correctness, tokens in/out, latency, hallucinated ids, missing-info.

## 5. Results
- **Certification (haiku, 60 maps):** textmap2 47.0% vs json 38.7%,
  McNemar b=108/c=58, χ²=14.46, p=0.0001. Tokens: 6.7k vs 10.0k avg.
- **Model tier (sonnet, 20 maps):** textmap2 56.5% vs json 38.5%,
  χ²=19.76, p<0.0001. Raw-geometry reading does NOT improve with model tier;
  representation gains COMPOUND with it.
- **Tokens per correct answer:** haiku json ~26k vs textmap2 ~14k.
- **Scale (350→2800m):** json 9.5k→18.4k tokens; textmap2 6.7k→9.7k at equal
  accuracy — equal accuracy at 47% fewer tokens at 2800m; size ratio widens
  1.48×→2.15× (chars, measured without model calls).
- **Ablations:** protocol lines are per-line (geometry-vs-topology +35 on
  path; a stale hint −15 on-street until removed). Image arm: 40%
  hallucinated ids (identity does not survive rasterization). Category map:
  entity-local categories dominated by textmap; crossing remains a raster
  limitation (over-approximation at 4–5m cells) — reported honestly.
- Per-category tables + accuracy-vs-token frontier figure from
  results/{certify-haiku-v23,matrix-sonnet,scale-haiku,ablation-protocol}/.

## 6. Lessons (each backed by a logged failure)
1. Labels lose to measurements; a legend should carry each fact once, as a
   measurement (the under=':' incident).
2. A question must carry its own judgment criterion (the 3m threshold).
3. Synthetic-grid degeneracies silently corrupt oracles (boundary-equality
   thresholds; collinear convex hulls).
4. Hints that outlive the defect they patched become noise (THRESHOLDS line).
5. Single-scene synthetic wins do not transfer — iterate on real data.

## 7. Limitations & future work
- Crossing/raster over-approximation; line-intersection at haiku floor.
- One city (Manhattan) — generalization to other morphologies pending.
- Agentic (multi-turn) reading understates one-shot gaps — a second axis.
- The grid as solver substrate (MILP over cells) — the OptiMind extension,
  follow-up paper.

## Appendix
- Full run logs (runlog.jsonl per run), pre-registered iteration log
  (docs/textmap-v2.md), harness (public repo).
