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

## Integrity boundary

Everything in v2 encodes the world, not the answers: layers, spacing, and
rulers are question-agnostic; baselines are untouched; the `verdict` arm remains
the labeled question-specific-precomputation ceiling.
