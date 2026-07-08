# textmap-research

A standalone research surface for evaluating how language models read and reason
over spatial scenes when those scenes are presented in different **representations**
— a plain-text "textmap", a virtual datastore the model browses with Read/Glob/Grep,
a rendered map image, and structured geometry.

This is the `repr-eval` experiment extracted from a larger application into a
self-contained Next.js app so it can run and deploy on its own.

## What's here

- `experiments/spatial-repr-eval/` — the eval core (pure TypeScript): scene
  generation (synthetic + real OSM), the representation builders (textmap, datastore,
  image URL, structured), the question/oracle/grading harness, model dispatch, and
  aggregate stats. `run-eval.mjs` is a standalone batch runner; `__tests__/` holds the
  unit tests for the oracle, textmap, and datastore logic.
- `app/api/experiments/repr-eval/` — HTTP routes: `run` (batch eval), `preview`
  (inspect a single scene's representations), `chat` (interactive agent that browses
  the scene datastore), `chat/seed`, and `selftest` (oracle sanity checks).
- `app/test-design/dev/repr-eval/` — a small dev UI to drive the eval and inspect
  results.
- `app/services/`, `app/types/`, `lib/types/` — the spatial / scene-modeling
  helpers the eval depends on (OSM lookup, scene "text twin" generation, geometry
  types). `lib/datastore/r2-upload.ts` is a thin stub for loading pre-indexed OSM
  extracts; see the OSM note below.

## Setup

```bash
pnpm install
cp .env.example .env.local   # then fill in the keys below
pnpm dev                     # http://localhost:3000
```

### Environment variables

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic key for the chat agent and eval runner. |
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway key for multi-provider model routing. |
| `NEXT_PUBLIC_MAPBOX_TOKEN` | Mapbox token for building static map image URLs (image representation). |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_ENDPOINT_URL` / `AWS_REGION` / `LAKEHOUSE_BUCKET` | *(optional)* Cloudflare R2 (S3-compatible) credentials for reading the pre-indexed OSM city extracts from Nexma's bucket. Use the same values Nexma uses. When unset, real-OSM scenes fall back to synthetic. |
| `OSM_DATA_BASE_URL` | *(optional)* Alternative to the R2 creds: a base URL serving the same `osm/buildings/{city}.json` + `osm/streets/{city}.json` files over HTTP. |
| `EVAL_SECRET` | *(optional)* Shared secret gating the model-calling routes (`run`/`preview`/`chat`/`chat/seed`). Unset = open (local dev). When set, callers must send the same value in an `x-eval-secret` header — the page has a `secret` field (persisted to localStorage) and `run-eval.mjs` takes `--secret`. Set this on any public deployment or anyone can spend the API keys. |

## OSM data

The real-scene routes load pre-indexed OpenStreetMap building/street extracts
(`osm/buildings/{city}.json`, `osm/streets/{city}.json`). The read goes through
`lib/datastore/r2-upload.ts`, which resolves in this order:

1. **A slice bundled in the repo** at `data/osm/...` — the default, self-contained
   path. A ~4.6×5.1 km Manhattan slice for `new-york` is committed (~10 MB,
   16k buildings), covering the `nyc` eval's seed jitter (±1 km around
   `-73.984,40.7549`) at every scale-sweep level up to 2800 m boxes.
2. **Cloudflare R2** when `AWS_*` + `LAKEHOUSE_BUCKET` are set — the same bucket
   Nexma uses, for full-city scale tests.
3. **`OSM_DATA_BASE_URL`** over HTTP, if set.
4. Else it throws, and the OSM services fall back to synthetic scenes.

### Generating / scaling the slice

OSM is public data, so the slice is fetched from Overpass with no credentials:

```bash
# default midtown NYC slice (already committed)
node scripts/fetch-osm.mjs --city new-york

# scale up: a larger bbox (minLon,minLat,maxLon,maxLat)
node scripts/fetch-osm.mjs --city new-york --bbox -74.02,40.70,-73.93,40.80
```

It writes `data/osm/buildings/{city}.json` + `data/osm/streets/{city}.json` in the
exact format the services expect. Commit the result to bundle it. For a true
full-city scale test, set the R2 credentials instead and let it read Nexma's extract.
`new-york` and `tel-aviv` have preset bboxes; pass `--bbox` for anything else.

## Running the experiment

The interactive page at `/test-design/dev/repr-eval` drives single runs (Workspace
demo + Eval proof, with CSV/JSONL downloads). For the full protocol — ~20 real maps,
6 representation arms, 10 oracle-graded questions across 8 categories, 3 repeats,
and the ×1/×2/×4/×8 scale sweep — use the batch driver against a local dev server
(big sweeps exceed serverless time limits):

Run it as TWO passes (a combined pass would exceed the server's 20k-call cap; they
are separate figures anyway):

```bash
pnpm dev   # in one terminal, with the API keys in .env.local

# Smoke first — a few dozen calls, verifies the whole pipeline end-to-end:
node experiments/spatial-repr-eval/run-eval.mjs --smoke \
  --models claude-haiku-4-5-20251001 --arms json,textmap,wkt --isolate true

# Pass 1 — main protocol (~12,000 calls): 20 maps × 10 questions × 3 repeats
node experiments/spatial-repr-eval/run-eval.mjs \
  --url http://localhost:3000 --source real --city nyc \
  --n 20 --repeats 3 --isolate true --seed 1000 \
  --models claude-haiku-4-5-20251001,claude-sonnet-4-6,claude-opus-4-8,openai/gpt-4o,google/gemini-2.5-flash \
  --arms json,wkt,textmap,image \
  --out results/main

# Pass 2 — scale sweep (~4,800 calls): 5 centers × 4 sizes, 2 models
node experiments/spatial-repr-eval/run-eval.mjs \
  --url http://localhost:3000 --source real --city nyc \
  --n 5 --repeats 2 --isolate true --seed 1000 \
  --models claude-haiku-4-5-20251001,claude-sonnet-4-6 \
  --arms json,wkt,textmap,image \
  --scale 350,700,1400,2800 \
  --out results/scale
```

It writes `results.csv` (per-item: correctness, tokens in/out, latency, hallucinated
ids, missing-info), `report.md` (Wilson CIs, per-category, per-scale, McNemar), and
`runlog.jsonl` (every composed prompt + raw structured answer — the full run record).
Estimate the call count first: it's printed before the request, and the server refuses
runs over its cap.

## Tests

The unit tests under `experiments/spatial-repr-eval/__tests__/` are written for a
Jest-style runner. They are excluded from the typecheck build; wire up a test runner
if you want to execute them.

## Type checking

```bash
pnpm exec tsc --noEmit
```

CI runs this on every push (`.github/workflows/typecheck.yml`).
