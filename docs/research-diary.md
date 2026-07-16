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

**RESULT: CAT composite 59.5 (n=200) — exactly at the threshold, qualifies
by the rule as written; CAT is the scale-up recipe.** Per category: path
25→55 (CTL→CAT, paired same seeds; predicted 70-90 — miss #4, mechanism =
the unstated closure→CO homing the smoke exposed), on-street 70→100
(predicted 80-90 — above band, calibration miss), 8-cat slice 55.0
replicating Run A's 55.6 on identical prompts+seeds. CTL confirmed the
generic-scan path collapse on fresh seeds (25%, predicted <40). Also
surfaced: line-intersection 0/20 in BOTH fresh-seed runs — compute-bound
(mental raycasting), the executor-shaped hole again; negative result kept.
Routed measured 2.0 pts higher (61.5); a post-hoc best-of-both recipe was
explicitly NOT assembled (recipe-shopping).

## 2026-07-16 — Cross-model scale-up + GeoFM hint rerun (in flight)

Prereg committed (textmap-v2.md): CAT on 7 models paired with their plain
textmap2 baselines at seed 1000 (deepseek 53.5, gemini-pro 54.5, grok
47.5, gpt-5-mini 47.5, qwen 31.5, kimi TBD, sonnet 56.5); success = ≥6/7
positive. Engineering fix first: free-text scan calls got a per-model
budget (scanMaxTokens; reasoning models truncated extractions to nothing
at 1500 — gpt-5-mini smoke returned 2.7k-char scans after the fix; haiku
unchanged at 1500 so the validation stands). 7-model smoke 12/14, zero
errors, all scans non-empty (~$0.5). GeoFM rerun: symmetric direction-rule
bullets on both arms' system prompts (--hint), predictions committed
(boundary flip expected). Chain of 9 runs fired sequential/detached,
est ≈ $39 of $52.51 balance.

## 2026-07-16/17 — Overnight: tools arm, scale-up lands, SFT prepped ($100 top-up → $191+$100 credited)

**Geometry-tools arm (probe ladder, ~$4 total):** the executor transplant.
Probe 1 (no geometry in legend): model INVENTS rings → blockage 1/5.
Probe 2 (v2.7 bbox extents): NYC's grid is rotated ~29°, bboxes 2-3× fat →
over-detection, 0/10, v2.7 KILLED per its rule. Probe 3 (v2.8 exact
footprint rings): **blockage 5/5 (from 0/20 baseline)**; crossing 0/5 —
tool round truncated at 1500 tokens + CABLES rows were cell-frame only.
Probe 4 (own 6k tool budget + meter cable endpoints): **blockage 5/5,
crossing 3/5 — arm validated.** Paper pair: approximation poisons an
honest executor in EITHER direction; segment×polygon needs exact rings.
Full validation (all 10 questions, fresh seeds, predict 70-77) queued in
chain 2.

**Cross-model scale-up RESULT: 6/6 decided models positive — the ≥6/7
criterion met.** deepseek 53.5→60.5, grok 47.5→54.5, qwen 31.5→39.0 (the
refuser improves), kimi 46.5→52.5 (below its +8-15 band — miss #5),
gpt-5-mini 47.5→55.5, sonnet 56.5→**68.0** (best number on the benchmark,
above opus plain). Kimi baseline new: **json 19.5 vs textmap 46.5 (+27.0,
starkest format gap yet)**. Sign test 6/6: p=.016.

**Incident 7 (gemini-pro, $7):** pipeline run scored 20.0 with zero
errors — runlog showed 80/100 answer calls truncated BEFORE the tool call
(thinking ate the 1024 answer budget on longer pipeline prompts) and 100%
of non-truncated answers were correct. Fix: maxTokens 8000 registered;
budget-matched baseline+pipeline rerun queued in chain 2. The 20.0 stays
in the record as the truncation datapoint.

**SFT (paper 1) fully prepped, $0 spent:** 6,000-example dataset (5,880
train + 120 val, ~18M tokens, 300 scenes at seeds 50000+ — disjoint from
every eval range; hold-out question types EXCLUDED; textmap2+json arms of
the same pairs; synthetic extraction traces; hints baked in; every label
self-checked against the grader — 0 failures). `together:` inference path
in the harness (trailing-JSON parse), scene-export endpoint,
docs/sft-launch.md with exact commands. Morning: paste TOGETHER_API_KEY →
upload → LoRA on Llama-3.1-8B-Instruct (~$10-20).

**Night chain 2 (prereg'd, ~$69):** gemini-8k rerun pair → tools full
validation → json+tools/wkt+tools symmetric test → llama-4-maverick +
llama-3.3-70b + mistral-large-3 columns → powered scale rerun (seed 3000)
→ repeats=3 stability. Fable 5 SKIPPED (decision: revision-if-asked).

Ledger checkpoint (gateway /credits): **$182.84 used, $108.16 balance**
(credited total now $291: $191 + $100 top-up 2026-07-17).

## 2026-07-17 morning — Chain 2 complete: ceiling broken, gap amplified

**Tools full validation: 72.5 (n=200, fresh seeds) — haiku's verdict
ceiling (61.5) BROKEN, +26.5 over plain.** Compute categories transformed
(line-intersection 0→90, crossing 35→60, mixed 36.7→63.3); read-bound
categories regressed under blanket tools (containment 100→70) → tool
ROUTING prereg'd (75-82) for chain 3.

**Format-symmetric tools test: the gap AMPLIFIES under tools.** Same
pipeline + same executor, native geometry each: textmap 72.5 ≫ json 47.5
≈ wkt 44.5. Plain gap +8.3 → tooled gap +25/+28 (both ≥8 preregs landed
at 3× threshold). Garbage-in mechanism: 15-digit degree marshaling vs
3-digit meters + precomputed legend fields.

**Cross-model final: 8/9 positive, sign test p=.002** (llama-70b
38.5→51.0 +12.5 above band; mistral 42.5→51.5 +9.0 in band; gemini-8k
the sole negative at −1.0 — its thinking substitutes for the pipeline;
truncation incident fixed and disclosed, 100% of non-truncated answers
correct). Baseline gap varies +2.5 (mistral) … +27.0 (kimi json 19.5).

**Scale, powered (n=200/cell):** textmap ≥ json at ALL 4 sizes; accuracy
gap converges (+11.0→+0.5) while token ratio grows (1.46×→1.89×);
accuracy-per-token ~1.9× everywhere. **Repeats (×3, temp 0): spreads
≤1.0 point — the gap is stable, protocol requirement closed.**

**Incidents 8-9:** maverick gateway deployment 405s on function calling →
noTools trailing-JSON fallback built, redo queued; chain 2 actual ~$98 vs
~$69 est (estimate-miss #3: 19k-token scale prompts, 3-call tools items).

**SFT saga:** v1 trained ($15.196, val loss 0.253→0.089); serving
gauntlet — serverless refused, batch refused (same error in error-file),
base+LoRA-hotload toggle disabled platform-wide → merged-checkpoint
dedicated endpoint (user-created, just-in-time, torn down per session).
Standalone eval path built (sft-eval.mjs — training-format prompts,
local grading) so SFT evals don't touch the dev server. v2 data ready
(1,000 scenes total). Phoenix third-morphology slice fetched (22k
buildings), registered, prereg'd.

Ledger checkpoint (gateway /credits): **$281.24 used, $9.76 balance** —
chain 3 (~$28, prereg'd, scripted) awaits final ~$40 top-up. Together:
$15.20 of $76 used + endpoint sessions ~$12-20 expected.

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
