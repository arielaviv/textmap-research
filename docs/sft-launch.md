# SFT launch guide — Together AI LoRA (paper 1)

Everything below the "you" line is ready; the dataset is generated and
committed metadata lives in the diary. Prereg: docs/textmap-v2.md, night
batch block E (predictions + kill criteria committed before generation).

## What exists already

- `sft-data/train.jsonl` + `sft-data/val.jsonl` — chat-format examples
  (system / user / assistant), textmap2 AND json arms of the same
  scene×question pairs, oracle labels self-checked against the grader,
  synthetic extraction traces, hints baked in. Train seeds 50000+ (disjoint
  from all eval seeds); hold-out questions excluded by construction.
- Harness inference path: any model id starting `together:` runs through
  `api.together.xyz` with the trained trailing-`ANSWER: {json}` format
  (core/model.ts `askTogether`), same grader as every other model.

## You (once, ~5 minutes)

1. Create an account at api.together.ai → Settings → API Keys.
2. Fund $25 (training ≈ $15-30 at ~30M tokens; inference pennies).
3. Give me the key, or put it in `.env.local` yourself:
   `TOGETHER_API_KEY=...` (also export it in the shell that runs eval).

## Then I run (or you can)

```bash
# 1. upload
curl -s https://api.together.xyz/v1/files \
  -H "Authorization: Bearer $TOGETHER_API_KEY" \
  -F purpose=fine-tune -F file=@sft-data/train.jsonl
curl -s https://api.together.xyz/v1/files \
  -H "Authorization: Bearer $TOGETHER_API_KEY" \
  -F purpose=fine-tune -F file=@sft-data/val.jsonl

# 2. create the LoRA job (fill the two file ids from step 1)
curl -s https://api.together.xyz/v1/fine-tunes \
  -H "Authorization: Bearer $TOGETHER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "meta-llama/Meta-Llama-3.1-8B-Instruct-Reference",
    "training_file": "<train-file-id>",
    "validation_file": "<val-file-id>",
    "n_epochs": 1,
    "learning_rate": 0.0001,
    "lora": true,
    "lora_r": 16,
    "lora_alpha": 32,
    "suffix": "textmap-v25"
  }'

# 3. poll until done (~hours)
curl -s https://api.together.xyz/v1/fine-tunes/<job-id> \
  -H "Authorization: Bearer $TOGETHER_API_KEY"
```

Base model choice: Llama-3.1-8B-Instruct-Reference — guaranteed LoRA
serverless inference on Together (a trained adapter is queryable
immediately, no dedicated endpoint cost). Qwen3-8B is the fallback if we
want a second family later.

## Evaluation (same benchmark, same grader, fresh seeds)

```bash
# SFT checkpoint (id from the finished job, e.g. <user>/Meta-Llama-3.1-8B-Instruct-Reference-textmap-v25)
node experiments/spatial-repr-eval/run-eval.mjs --url http://localhost:3377 \
  --source real --city nyc --n 20 --seed 2000 \
  --models "together:<ft-model-id>" --arms textmap2,json --isolate true \
  --out results/sft-eval

# Un-tuned base control (same everything)
node experiments/spatial-repr-eval/run-eval.mjs --url http://localhost:3377 \
  --source real --city nyc --n 20 --seed 2000 \
  --models "together:meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo" \
  --arms textmap2,json --isolate true --out results/sft-base

# Generalization: the held-out question types the SFT never saw
node experiments/spatial-repr-eval/run-eval.mjs --url http://localhost:3377 \
  --source real --city nyc --n 20 --seed 2000 \
  --models "together:<ft-model-id>" --arms textmap2,json --isolate true \
  --questions holdout --out results/sft-holdout
```

Pre-registered predictions (block E): SFT textmap 55-65, SFT json 38-45,
gap survives fine-tuning; kill if SFT textmap ≤ SFT json.
