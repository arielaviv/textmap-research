# SFT runbook — train → HF → serve → eval, the de-risked path

Every step below kills a specific failure hit during v1 (2026-07-16/17).
Follow in order.

## 1. Train (Together) — reliable, cheap
- Upload train/val JSONL (`together.files.upload`, purpose `fine-tune`).
- `together.fine_tuning.create(model=<base>, lora=True, lora_r=16,
  lora_alpha=32, n_epochs=2, learning_rate=1e-4)`.
- 8B ≈ $15/15min; gpt-oss-20B ≈ $95, longer.
- **DO NOT serve the fine-tune on Together** — dedicated endpoints serve the
  BASE weights, not your merge (proven by tensor byte-compare, 3× failures).
  Together is train-only.

## 2. Weights → HuggingFace (Colab cloud-to-cloud)
Avoids uploading 16GB from a weak/hotspot machine.
- Get Together's presigned merged URL:
  `GET /v1/finetune/download?ft_id=<id>&checkpoint=merged` (302 → URL).
- One Colab cell:
  ```python
  !apt-get -qq install -y zstd
  import subprocess, os
  url = "<presigned>"
  subprocess.run(["wget","-qO","m.tar.zst",url], check=True)
  os.makedirs("m", exist_ok=True)
  subprocess.run("tar --use-compress-program=unzstd -xf m.tar.zst -C m", shell=True, check=True)
  from huggingface_hub import HfApi
  HfApi(token="hf_...").upload_large_folder(folder_path="m", repo_id="<user>/<name>", repo_type="model")
  ```
- Note: local `tar` can't do zstd; Colab needs the apt install. Don't drag the
  .py into Colab (it parses as JSON) — paste the cell.

## 3. Serve (HF Inference Endpoints) — the exact config
- **A100 only.** L4/L40S have a hidden ~30GB host-RAM cap → OOM on 16GB
  weights (`Memory limit exceeded (30.0G)`).
- **TGI image via the RAW v2 API** (the Python SDK `custom_image` never
  passes env to the launcher → stuck at 4096 tokens → every ~3.8k-token
  prompt 422s). PUT to
  `https://api.endpoints.huggingface.cloud/v2/endpoint/<user>/<name>`:
  ```json
  {"model":{"image":{"tgi":{"url":"ghcr.io/huggingface/text-generation-inference:latest",
   "healthRoute":"/health","maxInputLength":12000,"maxTotalTokens":14000,
   "maxBatchPrefillTokens":14000}}}}
  ```
- Create with `create_inference_endpoint(..., instance_type='nvidia-a100',
  type='authenticated', custom_image={...same tgi env...})` then PUT to be sure.

## 4. Verify BEFORE any eval spend
- **No-system-prompt fingerprint**: send a val user-prompt with NO system
  message; a trained model still opens with `EXTRACTION:`. A base model
  answers in generic prose. (v1's first "PASS" was a false positive because
  the format was system-prompt-instructed — always test WITHOUT it.)
- Backup: tensor byte-compare a LoRA-target (`q_proj`) shard slice vs the
  stock base via HTTP Range — must DIFFER; layernorm must be IDENTICAL.

## 5. Eval
- Driver: `sft-eval.mjs --api-mode tgi` (client-side Llama-3.1 template +
  `/generate`; the `/v1/chat/completions` route hit a template bug on the
  image).
- Local machine: `NODE_OPTIONS=--max-old-space-size=1024`, invoke via
  `node node_modules/tsx/dist/cli.mjs ...` (pnpm shim sometimes "cannot
  execute the specified program"), concurrency 6, close other Claude
  sessions (VirtualAlloc/OOM on 8GB).
- **Delete the endpoint immediately after** (`get_inference_endpoint(...).delete()`).
  Pause (not delete) only for short breaks — pause keeps config, resume ~3min.

## Cost per model (serving): A100 ≈ $4/hr, full 3-suite eval ≈ 1-1.5h ≈ $5-6.
