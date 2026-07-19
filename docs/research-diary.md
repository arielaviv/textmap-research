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

## 2026-07-17 late morning — Chain 3, fable, the density finding; gateway program COMPLETE

**Tool routing: 75.5 (band 75-82 HIT, every per-category prediction hit,
cheaper than blanket) — THE FINAL RECIPE.** Haiku arc complete: 46.0 →
59.5 (reading = ceiling) → 72.5 (executor) → 75.5 (routed), 123% of the
handed-answers ceiling.

**London pipeline: 76.5 — ABOVE its 58-70 band (miss #8) and above NYC's
75.5. +31.0 over London plain (45.5/44.5 fresh pair). The NYC-tuned
pipeline generalizes across morphology emphatically.** Phoenix (third
morphology, sparse sprawl): 51.5 vs 50.8 (+0.7, below band — miss #9) —
**the plain-format gap is density-dependent**: huge in dense urban, nil
in easy sparse scenes; textmap never loses. Maverick clean pair: plain
46.0 vs json 20.0 (json below band — miss #11); pipeline 53.0/54.5
replicate pair. **12 models total; pipeline 9/10 positive, p=.011.**

**Fable 5 sniff ($30, n=50): 78.0 [64.8, 87.2] — 2 below the 80-90 band
floor (miss #10), kill avoided. The finding beats the number: at full
stack fable ≈ haiku (78.0 vs 75.5) — the SYSTEM equalizes models at the
frontier. And fable's path = 80 where haiku's gets 25-40: frontier
reasoning bridges the unstated-homing gap. Compat probe: forced tools +
routing work on fable unmodified.**

**SFT serving saga, night 2:** endpoint deployed via tg CLI v2 → served
BASE weights (fingerprint FAIL — the resource shell's config was bound to
base FP8 by the failed dashboard import; my "fingerprint PASS" on the
earlier endpoint was flawed verification — the EXTRACTION format was
system-prompt-instructed, not weight-proven; corrected method: NO-system-
prompt fingerprint). Fresh CLI resource + clean re-upload → "No configs
found"; configs never auto-generate for CLI resources (40-min poll).
All self-serve paths exhausted; morning plan: HuggingFace import route
(user makes token, ~15 min) + the support ticket. The trained model
remains verified-by-val-loss (0.089) and safely downloaded locally.

**Ledger (gateway /credits): $339.02 used, $6.98 balance.** Project
total: ≈$70 Anthropic + $339 gateway + $15.20 Together training +
~$3 endpoints ≈ **$427 all-in, self-funded.** Prediction-miss count: 11,
all published. Incident count: 12, all documented.

## 2026-07-17 midday — The serving mystery SOLVED: weights verified trained, platform bug confirmed

Third deployment (via the successful HF->Together import) served the SAME
word-for-word base output. Decisive test, no GPU needed: byte comparison
of tensors via HTTP Range against a stock Llama-3.1-8B mirror —
**LoRA-target q_proj DIFFERS from base; non-target layernorm is
byte-IDENTICAL** — the exact signature of a correct LoRA merge.
Conclusion: GeoGlyph-8B is trained and correctly merged; Together's
dedicated serving supplied base weights on all three attempts (the shared
serving config cr_Cd35... appears to bind its own weights). Evidence added
to the support ticket. Eval path pivots to HF Inference Endpoints
(~$2-3 total, API-managed) pending user billing setup. The no-system-
prompt fingerprint gate saved three would-have-been-corrupted eval runs.

## 2026-07-17 — GeoGlyph-8B v1 EVALUATED (after a 7-attempt serving saga)

Serving finally worked on HF Inference Endpoints (A100 + TGI image with
maxInputLength set via the raw v2 API — the SDK's custom_image never passed
env to the launcher). Path: Together served base weights (3×, proven by
tensor byte-compare) -> HF L4/L40S OOM'd on a hidden 30GB host-RAM cap ->
HF A100 default container = 7h no-batching -> TGI swaps ignored token
limits -> raw-API PUT with first-class tgi image config = success.

**Results (fingerprint-gated; base control FP8 = 12.5/15.0):**
NYC trained types 53.0 vs 39.0 (+14); London unseen-city 54.0 vs 40.5
(+13.5 — gap generalizes across morphology); hold-out unseen-question-types
32.5 vs 32.5 (+0 — SFT narrowing, prediction miss #12). Headline holds: a
$15 8B LoRA reaches deepseek-class accuracy in ONE call, beating its own
70B cousin (38.5) — 1000× less compute than OptiMind. Limitation is honest
and motivates v2's question-diversity expansion (10 -> 30-50+ templates).

HF endpoint deleted; billing stopped. Together SFT saga: 6 dead serving
attempts, all documented for the reproducibility appendix. Weights safe:
local + HF repo arielaviv/geoglyph-v1.

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


---

## 2026-07-18 — Tier 0–2: the pipeline goes 75.5 → 93 (in-sample)

Killed the executor-verified **self-correct loop** first: coverage-gated
retries measured +1.7 (noise) at ~$8 — the OptiMind correction loop
presupposes a verifier-rich domain (a solver that can say *infeasible*);
geometry computes wrong inputs silently, so there is no signal to correct
against. Negative result kept; loop dropped from the recipe.

Overnight 5-agent research (docs/pipeline-improvements-research.md)
converged on one principle: **move every reduce/enumerate/filter/argmin
step into the executor; materialize every question-agnostic world-fact
into the legend; make each hint name the right field.** Shipped as:

- `fe0fe02` — hint fixes. The `topology` hint was actively WRONG (walked
  CABLES source→target "up to the CO" — no closure→CO cable exists, plus a
  decoy closure-closure link). Added containment/onstreet/nearest hints
  (onstreet: use `d_street<=8`, IGNORE `on=` — an identity label, not a
  placement claim).
- `fb18e50` — three **reducer ops** (`segments_cross_polygons`,
  `filter_threshold`, `nearest_where`: the engine does the enumerate/
  threshold/argmin on model-supplied values only) + **worldFacts legend
  fields** (`street=`, `served_by=`, `up=`, `terminates_in=`, `hull=`).

Validation (sc-validate.mts, n=100, seeds 2000-2009): **93.0** —
crossing 60→100, road_misplacement 50→100, path→100, nearest_offstreet
→60, enclosure 80. Tokens 4.3M in / 136k out (~$5).

## 2026-07-19 — Independent audit, out-of-sample 92, and the lattice bug

Commissioned a fresh-context adversarial audit of the whole pipeline
(integrity, symmetry, grader leniency, honesty framing). Verdict: 93
genuine, executor integrity-clean, graders strict. Three real findings:

1. **`hull=` was the answer verbatim** — it printed the enclosure grader's
   own `interiorBuildings()` output per entity. REMOVED; enclosure now
   rides the `convex_hull` executor op (genuine marshal-compute).
2. **The 93 was in-sample** — measured on the exact 10 scenes the
   improvements were tuned against.
3. **THE LATTICE BUG**: `aoiForCity` jitter is `((seed*73)%100)` — it
   depends only on `seed % 100`, so every historical seed collapses onto
   a 100-tile lattice, and v1's "disjoint" train seeds 51000+i sat on
   EXACTLY the eval AOIs of 2000+i. v1 real-NYC training was fully
   geographically contaminated. (v1 still only scored 53 — but a reviewer
   would have been right to kill it.)

Also fixed from the audit: arm-aware tool hints/nudges (the tool-mode
crossing hint had named textmap-only fields to json/wkt), `countToolOps`
capped at the executor's 60-line limit, and the `nearest_offstreet` scan
override removed (its prose decomposition had measured 40→30, and
post-`street=` it pointed the scan at the wrong field).

**Out-of-sample validation** (sc-fresh.mts, seeds 2020-2029 — lattice
residues never used during tuning, post-audit config): **92.0**.
nearest_offstreet 60→**90** (the scan-override removal was worth +30);
enclosure 80→**60** (the price of deleting hull= — now the genuine
compute residual); everything else 90–100. Instance generalization holds:
the hints/legend are family-level, not scene-tuned. Headline the 92,
footnote the 93.

## v2 dataset — Defects A/B/C closed

- `core/task-bank.ts`: 30 trained families, **310 unique templates**,
  novel output schemas ({count},{meters},{direction},{quadrant},{street},
  {sameStreet},{onHull},{endpoints}), 10 reserved held-out families.
- `sft-generate-v2.mts`: **(A)** real 2-call masked traces — TOOL_RESULTS
  rides a USER turn (train_on_inputs=false masks it); executor output is
  genuinely computed by geo-tools; pre-tool turns carry marshals only,
  never conclusions; every label must pass its own grader (0 grade-fails);
  executor/oracle disagreements skipped and counted (164). **(B)** the
  template bank above, whole families held out. **(C)** train tiles hashed
  over the full bundled slice and REJECTED against all 100 lattice tiles —
  geographic disjointness from every legacy eval seed by construction
  (136 candidate tiles rejected). Plus 6 vocabulary skins (~20% generic).
- Output: **14,847 train + 303 val** from 200 scenes. chars/4 estimated
  ~72M tokens; Together's tokenizer counted **121M** — JSON-heavy text
  runs ~chars/2.9. (This 40% underestimate broke every cost projection.)
- `sft-eval-v2.mts`: the matching 2-call inference loop (+skin
  reverse-mapping for vocabulary-invariance tests; later hardened with
  240s request timeouts + retry after a hung stream wedged a run).

**Naming settled: GeoGlyph** for representation, bench and models
(GeoGlyph-Bench, GeoGlyph-8B/20B). Argus rejected (collides with our own
satellite engine + several ML ARGUS papers); AtlasLLM rejected (Meta's
Atlas + the X-LLM suffix curse).

## 2026-07-19 — the 20B micro-canary (path B)

Real prices, learned the cheap way (billing-limit cancellations quote the
exact cost for free): 8B epoch **$67.74** (ft-23dde913-767e), 20B epoch
**$188.92** (ft-5d059873-fcbb). At those prices the "$33 8B canary before
the $200 20B" insurance logic was dead — replaced with a **20%-subset
micro-canary on the 20B itself** (tests the flagship's OWN risks: Harmony
format, MXFP4, expert-MLP adapters — the same pitfalls OptiMind's A.7
documents working around with Unsloth/FSDP2).

**ft-6ecd701c-450c**: 2,969 examples (first 20% of the shuffled set,
train-part1.jsonl), LoRA r32/α64 all-linear, lr 5e-5, 1 epoch,
train_on_inputs=false. **$40.10, 12m30s, train loss 0.92→0.40** (eval
0.4152 — no gap). Together's fine-tune→serving path now works (their
engineering fixed the dropdown/weight-translation bug); endpoint
`geoglyph-p1` on 1×H200 ($0.11/min). Gotchas: the CLI `endpoints` command
is project-scope-blind (create 403s, list shows empty while a UI endpoint
serves) — endpoints via UI only; the Together WAF 403s python-urllib UAs
(use curl / node fetch).

**Mechanics gate: PASSED** (sft-eval-v2, 40 items, seeds 2020-2021):
tools fired on compute questions, **0 marshal-fails, 0 errors, no
hallucinated TOOL_RESULTS** — the masked-2-call recipe trains. Score at
20%-data/1-epoch: **textmap 60.0** (above fully-trained v1's 53), json 15.

**Base-model control** (untrained gpt-oss-20b, same scaffold, same items).
First run: 55/10 — but **19/40 EMPTY responses**: the base's reasoning
tokens ate the max_tokens caps before the final channel produced anything
(predicted in advance as the anti-base bias; the mini-probe at a 250-token
cap had already shown an empty final). Fair rerun at 8k/12k caps
(prediction committed first: ~70 textmap / ~30 json):

**base-fair: textmap 65.0 (3 residual empties), json 25.0** — both inside
the predicted bands. Verdict on the canary:

    accuracy: 12/20 vs 13/20 — a statistical tie (one item, n=20)
    tokens:   473 vs 3,837 per item (8.1x)
    latency:  3.2s vs 36.2s per item (11.3x)
    errors:   0 vs 3; marshal-fails 0 vs 0; base skipped the tool
              protocol on most compute questions (crossing 0/4)

Reading: at 20% of one epoch the student already matches the thinking
base while spending an eighth of the tokens — the distillation is moving
reasoning into weights, accuracy expected to follow with data (loss still
descending at cutoff). Queued discriminators for the next endpoint
session: canary at forced reasoning-effort-high, ±external-scan,
±hint-with-TOOL_RESULTS.

Continuation ready: part2 (11,878 ex) uploaded as
file-94929882-0f34-4e46-b327-9081da02fc6e; continue-from-checkpoint
≈$145 completes the epoch with the $40 inside it. Balance $15.67;
awaiting ~$150 top-up.

Separately: the results page (GeoGlyph-Results/index.html) grew into the
full paper draft — worked transcripts pulled verbatim from the released
dataset (scenes rebuilt byte-identical from their seeds), a real failure
gallery (geojson/wkt/PNG graded items), MapEval-style composition
figures, GPSBench-style ground-truth formulas (MathJax), strategically
positioned related work, discussion/limitations, ODbL attribution.


## 2026-07-19 (late) — the canary characterization: FT damaged the reasoning channel

Full 5-config scoreboard on identical items (40; 2 scenes, seeds 2020-2021),
student = the $40 20%-epoch checkpoint on its dedicated endpoint, base =
untrained gpt-oss-20b, both under the full scaffold:

    config          textmap  json   tok/item  s/item
    canary fast        60      15      473      3.2
    canary low         45      20    1,593       —
    canary high        40      30    1,634       —
    base   low         80      35    2,311     21.3
    base   high        65      25    3,837     36.2
    (teacher ref: haiku = 92)

Two shocks. First, base-at-Reasoning:low scored **80** — the committed
prediction was ~45, a 35-point miss (the earlier fair-base run at HIGH had
scored 65; LIGHT thinking is this model's best mode on our scaffold, heavy
thinking overthinks past it). An open $0.05/M model at 80 with our pipeline
is itself a paper-worthy datapoint — pending n=100 confirmation.

Second, the canary **degrades monotonically as reasoning effort rises**
(60 → 45 → 40) while the base improves from fast (unusable: empties) to
low (80). The CSV autopsy made the mechanism unambiguous: at forced
Reasoning:high the canary answers every enumerate-class question with an
EMPTY ARRAY in a couple hundred tokens (containment [] @179 tok,
coverage_gap [] @159, crossing [], blockage [] — same items the base fills
correctly with ["CL-I"], ["B-5","B-9"], three drops). Not a data-balance
artifact — only 9.1% of training answers are empty arrays (sampled
n=2,969). The v3 targets are terse final answers with NO reasoning
content, so on a Harmony reasoning model every gradient step teaches the
answer format AND "think nothing": the analysis channel is trained toward
empty. At 20% of an epoch the model has learned to stop deliberating
before absorbing the competence deliberation used to supply — so it emits
the minimum-loss guess, []. Chain-of-thought is computation performed in
the generated tokens; a policy trained not to generate them loses the
ability's output even though the circuitry (a LoRA away) is intact.

Why v1-8B never hit this: Llama-3.1-8B is a non-reasoning base scoring
~30s — nothing to damage, everything to gain (→53). gpt-oss-20b's 80 IS
its deliberation; the same data pulled one model up and the other down.
SFT moves a model toward the data; our data sits at "answers like a 53-60
model, instantly."

**Decision (pre-agreed rule: <55 at low → pause): the $145 continuation is
PAUSED.** More of the same targets pushes further in the same direction —
v1's fully-trained 53 looks like the ceiling of format-without-reasoning.

**v3.1 — self-distillation.** Fix the targets, retrain fresh:
teacher = the untrained base at Reasoning:low under the full scaffold,
posed the task-bank examples on fresh eval-disjoint train tiles; traces
survive only if the final answer grades correct (rejection sampling —
core families via the real graders, bank families via normalized
deep-equality). Together's fine-tune format accepts a `reasoning` field
on assistant turns (and per-message `weight`), so the teacher's analysis
trace trains the analysis channel directly — same channel at train and
inference. The "Reasoning: low" directive is present when asking the
teacher but stripped from the stored system turn: low-effort deliberation
becomes the default, not a string-triggered mode. Because the teacher
skips tools (and fails) on many compute questions, tool supervision would
thin out post-filter — so a slice of v3's 5-message rows rides along with
the terse final turn at weight 0, keeping the correct-by-construction
marshal turns without re-teaching answer-without-thinking.

Built as sft-distill.mts; smoke (6 conversations): reasoning harvested on
every distilled row, oracle pass 83%, marshal slice weighted 1/0, skins
verified in-trace (the sample deliberates over HB-1/DP-A — the logistics
vocabulary). Gates before the ~$100: (1) teacher confirm n=100 fresh
seeds; (2) trace-in-target inspection of sample rows; (3) exact-price
quote via the billing-limit trick; (4) 20% micro-canary, pass = best-mode
≥70 AND no degradation with effort — the monotonic drop is the signature
of the defect, its absence is the proof of the fix. Bar for the finished
model unchanged: ≥80 at its best mode on held-out seeds, else the recipe
failed and the paper ships on representation + scaffold + this negative
result.
