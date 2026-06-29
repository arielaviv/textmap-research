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
(`osm/buildings/{city}.json`, `osm/streets/{city}.json`) that live in Nexma's
Cloudflare R2 bucket. That read goes through `lib/datastore/r2-upload.ts`, which:

1. reads directly from R2 when the `AWS_*` credentials + `LAKEHOUSE_BUCKET` are set
   (use the same values Nexma uses — this is the intended path), or
2. fetches `{OSM_DATA_BASE_URL}/{key}` over HTTP if that's set instead, or
3. throws — which the OSM services catch, so the eval falls back to synthetic scenes.

The extracts are not committed to this repo; they are served from R2.

## Tests

The unit tests under `experiments/spatial-repr-eval/__tests__/` are written for a
Jest-style runner. They are excluded from the typecheck build; wire up a test runner
if you want to execute them.

## Type checking

```bash
pnpm exec tsc --noEmit
```

CI runs this on every push (`.github/workflows/typecheck.yml`).
