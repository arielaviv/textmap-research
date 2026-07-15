# Spatial-Representation Eval — Results

Config: {"source":"real","city":"nyc","n":20,"models":["google/gemini-2.5-pro","xai/grok-4.1-fast-non-reasoning","deepseek/deepseek-v3.2","alibaba/qwen-3-235b"],"arms":["json","textmap2"],"temperature":0,"repeats":1,"seed":1000,"isolate":true,"questionIds":null,"scale":null,"totalCalls":1600}

Total items: 1600 (errors: 0)


## Accuracy by arm (95% Wilson CI)

| Arm | Accuracy | 95% CI | n | avg in-tok | avg out-tok | avg latency | halluc. | missing-info |
|-----|----------|--------|---|-----------|------------|--------|---------|--------------|
| textmap2 | 46.8% | [43.3%, 50.2%] | 800 | 6335 | 206 | 3.4s | 4.8% | 0.0% |
| json | 35.6% | [32.4%, 39.0%] | 800 | 11948 | 228 | 3.8s | 0.0% | 1.6% |

## Accuracy by arm × category

| Arm | Category | Accuracy | 95% CI | n |
|-----|----------|----------|--------|---|
| textmap2 | coverage | 71.3% | [60.5%, 80.0%] | 80 |
| textmap2 | line-intersection | 2.5% | [0.7%, 8.7%] | 80 |
| textmap2 | on-street | 76.3% | [65.9%, 84.2%] | 80 |
| textmap2 | mixed | 27.9% | [22.6%, 33.9%] | 240 |
| textmap2 | containment | 70.0% | [59.2%, 78.9%] | 80 |
| textmap2 | nearest | 93.8% | [86.2%, 97.3%] | 80 |
| textmap2 | crossing | 35.0% | [25.5%, 45.9%] | 80 |
| textmap2 | path | 35.0% | [25.5%, 45.9%] | 80 |
| json | coverage | 52.5% | [41.7%, 63.1%] | 80 |
| json | line-intersection | 1.3% | [0.2%, 6.7%] | 80 |
| json | on-street | 78.8% | [68.6%, 86.3%] | 80 |
| json | mixed | 7.1% | [4.5%, 11.0%] | 240 |
| json | containment | 20.0% | [12.7%, 30.0%] | 80 |
| json | nearest | 97.5% | [91.3%, 99.3%] | 80 |
| json | crossing | 40.0% | [30.0%, 51.0%] | 80 |
| json | path | 45.0% | [34.6%, 55.9%] | 80 |

## Pairwise comparison (McNemar, paired)

| Arm A | Arm B | acc A | acc B | b | c | χ² | p |
|-------|-------|-------|-------|---|---|----|---|
| textmap2 | json | 46.8% | 35.6% | 137 | 48 | 41.86 | 0.0000 |

_b = A correct & B wrong; c = A wrong & B correct. p<0.05 ⇒ the arms differ significantly._
