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

## OSM data

The real-scene routes load pre-indexed OpenStreetMap building/street extracts
(`osm/buildings/{city}.json`, `osm/streets/{city}.json`). The read goes through
`lib/datastore/r2-upload.ts`, which resolves in this order:

1. **A slice bundled in the repo** at `data/osm/...` — the default, self-contained
   path. A midtown-Manhattan slice for `new-york` is committed (~3 MB), which covers
   the area the `nyc` eval samples (center `-73.984,40.7549`, ~350 m boxes).
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

## Tests

The unit tests under `experiments/spatial-repr-eval/__tests__/` are written for a
Jest-style runner. They are excluded from the typecheck build; wire up a test runner
if you want to execute them.

## Type checking

```bash
pnpm exec tsc --noEmit
```

CI runs this on every push (`.github/workflows/typecheck.yml`).
