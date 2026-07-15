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

**Vercel AI Gateway (credited $191.00 total: $64.73 + $26.27 + $50 + $50):**

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
| Booster screening 8 conditions + few-shot addendum (2026-07-16) | ~$25 |
| P-full screen (HSCZ + votes 5 + turns 5) | ~$25 (vs $15 est — voting×turns×scan multiply; miss logged) |
| Routed validation Run A (HSCZ, 8 cats) + Run B (H-only, 2 cats), fresh seeds | ~$6 |
| Category-scan smokes (4 items, incl. the 3¢ that caught the CO-drop bug) | ~$0.15 |
| **Used through 2026-07-16 (pre cat-scan validation)** | **$138.49 (exact, per gateway /credits)** |
| Cat-scan validation CTL+CAT, fresh seeds (in flight) | ~$6 est |

**Project total to date: ≈ $208.50 spent ($70 Anthropic + $138.49 gateway) +
$52.51 gateway balance in play.**
(Figure excludes Claude Code development time — subscription, not API.)

## 2026-07-16 — Booster screening ($25 + $50 top-ups)

Pipeline built (hints / voting / turns / scan / citations / zoom / few-shot),
typechecked, pushed. 8-condition screen + few-shot addendum + full-P screen,
all: 20 NYC maps (seeds 1000-1019, pairs with certified baseline), haiku,
textmap2 arm, n=200 each.

| Condition | Acc | Δ vs 46.0 baseline |
|---|---|---|
| H (hints) | 48.0 | +2.0 (prediction 52±3 MISSED) |
| HC | 49.0 | +3.0 |
| HF (few-shot) | 49.0 | +1 over H (prediction MISSED) |
| HCZ | 49.5 | +3.5 |
| HSCZF | 50.0 | −6 vs HSCZ — few-shot interferes |
| HSF | 51.0 | −3 vs HS |
| HZ (zoom 1.5×) | 52.0 | +6.0 |
| HSZ | 53.0 | +7.0 |
| HSC | 53.5 | +7.5 (rerun after incident 4) |
| HS (scan) | 54.0 | +8.0 |
| **HSCZ** | **56.0** | **+10.0 — best** |

Marginals: **scan +4.5 avg (positive in all 4 pairs — the extraction-gap
thesis measured)**; zoom +1.5 (mixed, +50% tokens); citations +0.3 (noise);
few-shot DROPPED (interferes with scan — GeoFM's few-shot gain does not
transfer to scene-scale reading; kept as negative result). Token cost of
the stack ≈ 2.3×; haiku+HSCZ (56.0) approaches haiku's verdict ceiling
(61.5) — the pipeline recovers most of the extraction gap.

Incidents: (4) citations condition induced string-for-array schema
violations → a grading crash 500'd a whole run; fixed with type coercion at
ingestion + per-item crash isolation; HSC rerun $1.7. (5) a wrong `&`
placement ran a detached launch foreground → 2-min timeout killed the
driver mid-run, server billed headless ~$1-2 until killed; refired with the
proven pattern. Final screen in flight: HSCZ + votes 5 + turns 5
(complete P), predicted 58-61.

## 2026-07-16 — P-full result, routing discovery, routed validation

**P-full (HSCZ + votes 5 + turns 5): 53.0 — BELOW HSCZ's 56.0 at ~10× the
cost. Prediction 58-61 MISSED (3rd miss, published).** Voting and turns
REGRESS on this task: haiku's reading errors are systematic, not noisy
(majority voting amplifies the modal error), and the verifier has no
executor to generate real feedback (OptiMind's loop closes through a
solver; ours can only check id existence). Both dropped. The OptiMind
transplant boundary, measured: representation-native mechanisms (hints,
scan) transfer; executor-dependent ones (voting, turns) don't.

**Routing discovery:** per-category screening surfaced that scan TRANSFORMS
coverage (20→95) and containment (75→95) but DESTROYS path (90→15) and
dents on-street (85→75). One recipe cannot win both → route by question
category (legitimate: keyed on the question, known at ask time; OptiMind
routes by problem class identically). Recipe: HSCZ for 8 categories,
hints-only for path/on-street.

**Routed validation on FRESH seeds 2000-2019 (never used anywhere;
prediction 58-63 committed before the run): Run A HSCZ 55.6 (n=160) + Run B
H-only 85.0 (n=40) → composite 61.5. Band HIT. Equals haiku's verdict
ceiling (61.5) — the pipeline recovers the ENTIRE extraction gap. +15.5
over the 46.0 certified baseline.** Caveat logged: single-recipe comparison
numbers came from screening seeds; same-seed control queued.

## 2026-07-16 — Category-aware scan (pipeline v2)

Next idea, pre-registered before any call: instead of routing AROUND scan
for path/on-street, the scan's extraction brief routes BY category (path →
connectivity graph; on-street → street-placement facts), so ONE recipe
covers all 10 questions. Implemented behind `--scan-targets` (generic scan
stays runnable as the control); templates quoted verbatim in the notebook.

Incident 6 (cheapest yet, $0.03): the 1-item smoke answered `["CL-A"]` vs
truth `["CL-A","CO-1"]` — the first-draft brief said "extract serves lists
+ cable endpoints" and the CO serves nothing, so the extraction DROPPED the
source and the answer anchored on a CO-less graph. Template revised (keep
every entry incl. roots) BEFORE validation; smoke seeds 9500+ disjoint from
validation seeds. Also added: per-item `scanText` in runlog.jsonl — the
record now shows exactly what each answer anchored on.

Re-smoke 2/3; the miss is PRINCIPLED: extraction perfect, model refused to
place CO-1 on the path because no stated link connects closures to the CO,
and flagged missingInfo — it is right about the stated facts; the oracle's
truth encodes an unstated homing convention. Not patched via prompt (that
would inject the oracle's rule); deferred as v2.7 `feeds=` field on the
source row (world fact, question-agnostic). Paper note: the pipeline makes
the model MORE faithful to stated facts — faithful enough to expose
benchmark truths resting on unstated conventions.

Validation fired (fresh seeds 2000-2019, ~$6): CTL = HSCZ generic on
topology+onstreet (same-seed head-to-head for the 2 changed categories);
CAT = HSCZ+targets on all 10 (its 8 untouched categories double as a free
same-seed replicate of Run A). Decision rule pre-registered: scale-up
recipe = CAT if composite ≥ 59.5, else routed.

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

## Queued (balance $52.51; designs ready)

All-model scale-up with the winning recipe (cat-scan or routed) vs
baseline: gemini, deepseek, grok, qwen (protocol-refuser test), kimi (needs
baseline too), gpt-5-mini, sonnet — 20 maps each ~$32 · GeoFM rerun with
the direction-rule hint (boundary flip test) ~$8 · already-covered
same-seed control folded into the cat-scan validation. Voting/turns and
few-shot DROPPED after screening (negative results, kept in the record).
Then: paper build (Task 18), SFT paper-2 (Qwen3-8B LoRA on Together,
hints+scan traces baked into training, ~$20-45, separate budget).
