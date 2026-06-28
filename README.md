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
| `OSM_DATA_BASE_URL` | *(optional)* Base URL serving pre-indexed OSM city extracts. When unset, real-OSM scenes are unavailable and the app falls back to synthetic scenes. |

## OSM data

The real-scene routes load pre-indexed OpenStreetMap building/street extracts. In the
original application these came from object storage; here that read goes through
`lib/datastore/r2-upload.ts`, which fetches from `OSM_DATA_BASE_URL` if set and
otherwise throws — the OSM services catch this and report no data, so the eval still
runs on synthetic scenes.

## Tests

The unit tests under `experiments/spatial-repr-eval/__tests__/` are written for a
Jest-style runner. They are excluded from the typecheck build; wire up a test runner
if you want to execute them.

## Type checking

```bash
pnpm exec tsc --noEmit
```

CI runs this on every push (`.github/workflows/typecheck.yml`).
