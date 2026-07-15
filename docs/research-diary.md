# Research Diary — TextMap project

Complete chronological record of everything tried, run, spent, broken, and
decided. Companion to `docs/textmap-v2.md` (the pre-registered design
notebook — predictions live THERE, before each run). This file is the
process history, OptiMind-style: error analysis → intervention → measured
result, with costs. Maintained continuously; every entry dated.

---

## 2026-06-25 — Protocol

Eliav's protocol email: all-English maps, ~20 maps, 4 formats (image,
GeoJSON, WKT, textmap), question categories (list attached by him), ≥3
models, metrics = correctness / tokens in / tokens out / latency /
asked-missing-info / hallucination, repeated runs, full logging of every
prompt+result, and a scale test.

## Early July — Harness build ("close all gaps")

Standalone public repo (extracted from the Nexma monorepo). Built: WKT arm,
8-category taxonomy + mixed questions, latency/hallucination/missing-info
metrics, full prompt+response logging (runlog.jsonl), scale sweep, model
registry incl. gateway vendors, eval-route auth, batch driver
(run-eval.mjs), results UI. 13 commits. Verification: tsc + selftest
(oracle sanity 9/9) — no eval spend.

## 2026-07-08/09 — Overnight program ($50 cap; Anthropic account)

Iteration by probe($0.1) → validate($3–5) → certify($10) with pre-registered
predictions per change (full trail: textmap-v2.md).

| Run | Config | Result | Note |
|---|---|---|---|
| main-haiku / v22 | 20 maps × 6 arms | v2 ties json on real maps after synthetic wins | transfer failure diagnosed from runlogs → protocol lines |
| certify-haiku-v23 | 60 maps, json+textmap2 | **47.0% vs 38.7%, McNemar p=0.0001** | THE headline; distinct maps × 1 repeat (temp-0 repeats are correlated — earlier p=0.0033 on 3 repeats DISCARDED as invalid) |
| matrix-sonnet | 20 maps | 56.5 vs 38.5, p<0.0001 | tier curve point |
| matrix-opus | 20 maps | 64.5 vs 34.5, p<0.0001 | **cost blunder: estimated ~$7, actual $19.31** (anchored on haiku pricing); drained the account. Rule since: compute cost from measured tokens × correct pricing BEFORE launching |
| ablation-protocol | 400 calls | protocol lines are per-line: +35 path (geometry-vs-topology), −15 stale THRESHOLDS hint (removed) | hints that outlive their defect become noise |
| ceiling-verdict | 200 calls | verdict arm (answers precomputed) = 61.5% haiku | textmap = 76% of ceiling, json = 63%; absolute scores bounded by answer calibration, not only reading |
| scale-haiku + sizes | 350→2800m | json 9.5k→18.4k tok; textmap 6.7k→9.7k, equal acc | −47% tokens at 2800m |

Anthropic spend total (whole project, measured from logs): **$67.73** + ~$2
probes ≈ **$70**. Balance ≈ $0 after the opus run.

**Bottleneck finding:** GeoJSON accuracy FLAT across tiers (38.7 → 38.5 →
34.5 — differences within noise) while textmap climbs (47.0 → 56.5 → 64.5).
On identical 20 maps: json 37.5/38.5/34.5 vs textmap 46.0/56.5/64.5.

## 2026-07-12/13 — Write-up prep

Results brief (Hebrew email to Eliav sent; his reply: start sending content
for the paper). Spatial-spread audit: the 60 NYC maps are 350m windows
inside ONE ~2.2×1.7km neighbourhood (±0.01° jitter), windows overlap —
logged as caveat + fix (wider jitter) queued. paper-skeleton.md drafted.

## 2026-07-14 — Results brief v2

OptiMind-style bar figures (4 SVG figures), plain academic page → PDF via
headless Edge. CSVs renamed for attachment. Correction adopted: never say
"haiku beats opus on GeoJSON" — differences are noise; the claim is
flatness.

## 2026-07-15 — The big day (Vercel AI Gateway, $64.73 credits)

Gateway key installed; 11 vendor models registered; forced-tool-call probe
OK. **Incident 1:** first WKT+image 60-map run — 1,190/1,200 calls 429
"free tier": account had no PAID credits. $0 lost (failed calls unbilled).
User topped up.

| # | Run | Config | Result | Cost |
|---|---|---|---|---|
| 1 | holdout-haiku | 60 maps × 2 arms × 6 NEW question types (pre-registered + kill criterion, committed BEFORE run) | **48.3 vs 43.1 (+5.2, inside predicted +3..+8 band)**, p=0.051; 5/6 per-question predictions correct; kill criterion NOT triggered | $6.3 |
| 2 | certify-london | 60 maps, irregular morphology, doubled jitter (non-overlapping windows) | **46.7 vs 42.2 (+4.5), p=0.023** — generalizes; honest notes: coverage FLIPPED (20 vs 45), textmap halluc 2.7% | $10.6 |
| 3 | formats-wkt-image | 60 maps, wkt+image arms (pairs with certify seeds) | **4-format table done: textmap 47.0 > json 38.7 > wkt 36.5 ≫ image 18.7 (halluc 32%)** | $7.3 |
| 4a | matrix-vendors | 20 maps × 4 vendors × 2 arms | pooled **46.8 vs 35.6, p<0.0001**; Gemini +19.0, Grok +17.5, DeepSeek +15.0, **Qwen −7.0** (does not follow the reading protocol: topology 5/20, halluc 18.5%) | $8.5 |
| — | Incident 2 | first 4a attempt died at undici 300s headers timeout; server kept billing headless | ~$5 lost; fix: undici dispatcher timeout=0 in driver |
| — | Incident 3 | GPT-5 15-map run killed by local task runner ~10 min in; server kept billing | ~$10–15 lost; fix: detached launches; GPT-5 probe (1 map): textmap 70 vs json 50, out-tokens 5.6k/call (reasoning) |
| 5 | geofm-task1 | EXTERNAL: GeoFM (2505.17136) Task 1, their 1,400 triplets, their verbatim prompt+grading; disclosed deviation: last-triple extraction grading (haiku narrates; applied to both arms equally) | **kill criterion INVOKED: wkt 58.9 vs textmap 56.6.** Inside it: disjoint 97/76, equals 92/81 (textmap), contains 18/59 (COLLAPSE). Confusion mining: 90/200 contains answered as within — DIRECTION INVERSION, not raster failure | $7.6 |
| 6 | matrix-gpt5mini | 20 maps × 2 arms, OpenAI column | **textmap 47.5 vs json 37.5 (+10.0)**; clean-items 51.4 vs 39.5 (25 transient fetch errors excluded) | ~$5.5 |
| 7 | formats-gemini | 20 maps, wkt+image on a second vendor | **image collapse REPLICATES: 7.0% acc, 32.5% hallucinated ids** (haiku: 18.7%, 32%); wkt 27.5 below gemini's json 35.5 | ~$3 |

**Account exhausted to the cent:** balance −$0.26 after run 7 (last 25 gemini
calls bounced on 402 credit-required — excluded, run 375/400 complete).
**The experimental program (tiers 1+2 + external validation) is COMPLETE.**
Cross-vendor bottleneck table final: raw GeoJSON 30–38.5% for ALL 8 models
(4 labs); textmap 46.8–64.5% on 7 of 8 (Qwen the protocol-refusing
exception). Hallucination on image arm replicated at ~32% on both vendors
tested.

Error taxonomy mined from runlogs (all free):
- coverage: empty-set aversion — models INVENT gaps (26/35 textmap wrong
  items named 1–3 buildings; every legend d_closure < 35m)
- crossing asymmetry: json wrong = 33/37 EMPTY (under-detect); textmap
  wrong = 1–5 spurious cables (raster over-detect) — opposite failure modes
- topology: residual glyph-tracing despite protocol line
- GeoFM contains: direction inversion (90/200) — reading rule gap, fixable
  by hint; touches/crosses = genuine sub-cell raster limits

→ `core/hints.ts` written: per-category, arm-specific hints, each citing
its logged error pattern. Baseline results remain frozen; hint arms are a
separate labeled condition (OptiMind structure: baseline → error analysis →
hints → measured lift).

Vercel spend to date: ~$57 of $64.73 (balance $7.86 at 22:30, runs 6 in
flight).

## Money ledger — ALL LLM spend (updated per run)

**Anthropic API (direct; account drained ~Jul 9):**

| What | Tokens | Cost |
|---|---|---|
| All haiku runs (7 runs, 4,640 calls) | 37.1M in / 0.21M out | $38.15 |
| Sonnet 4.6 matrix (400 calls) | 3.33M / 0.017M | $10.25 |
| Opus 4.8 matrix (400 calls) | 3.77M / 0.019M | $19.33 |
| Probes/iteration (unlogged small runs) | — | ~$2 |
| **Anthropic subtotal** | | **≈ $70** |

**Vercel AI Gateway (credited $91.00 total: $64.73 + $26.27 top-ups):**

| What | Cost |
|---|---|
| Hold-out 60-map (720 calls) | $6.3 |
| London certification (1,200) | $10.6 |
| WKT+image 60-map (1,200) | $7.3 |
| Vendor matrix ×4 (1,600) | $8.5 |
| Incident: aborted vendor run (undici) | ~$5 |
| GPT-5 probe (20 calls) | $1.3 |
| Incident: GPT-5 killed run (billed headless) | ~$10–15 |
| GPT-5-mini matrix (400) | ~$5.5 |
| Gemini wkt+image (400) | ~$3 |
| GeoFM external (2,800) | $7.6 |
| Smokes/probes | ~$0.4 |
| **Used through 2026-07-15** | **$65.26 (exact, per gateway)** |
| Booster screening 8 conditions (2026-07-16, in flight) | ~$18–20 est |

**Project total to date: ≈ $135 spent + $25.74 gateway balance in play.**
(Figure excludes Claude Code development time — subscription, not API.)

## Standing integrity rules (accumulated)

1. Predictions pre-registered in textmap-v2.md BEFORE every run; kill
   criteria stated; misses reported (2 invoked to date, both published).
2. Temp-0 repeats are correlated — distinct scenes only.
3. A question must carry its own judgment criterion (thresholds in prompt).
4. Legends carry measurements, not judgments; hint text teaches reading,
   never scene facts.
5. Compute cost from measured tokens × verified pricing before launching.
6. Long runs: detached processes + undici timeout off; kill the server if
   the collector dies (billing continues headless).
7. Every run's full prompts+answers in runlog.jsonl, committed.

## Queued (awaiting ~$200 top-up; designs ready)

Hints with/without × all 10 models (incl. Kimi baseline) ~$85 · voting K=5
+ self-correction turns (3 models) ~$67 · hints on hold-out/London +
vocab-invariance probe + GeoFM+hints (boundary flip test) ~$28. Then: paper
build (Task 18), SFT paper-2 (Qwen3-8B LoRA, ~$60, separate).
