# Spatial-Representation Eval — Results

Config: {"source":"real","city":"nyc","n":20,"models":["anthropic/claude-haiku-4.5"],"arms":["textmap2"],"temperature":0,"repeats":1,"seed":2000,"isolate":true,"questionIds":["containment","crossing","coverage","nearest","line-intersection","mixed"],"scale":null,"hints":true,"votes":1,"turns":1,"totalCalls":160}

Total items: 160 (errors: 0)


## Accuracy by arm (95% Wilson CI)

| Arm | Accuracy | 95% CI | n | avg in-tok | avg out-tok | avg latency | halluc. | missing-info |
|-----|----------|--------|---|-----------|------------|--------|---------|--------------|
| textmap2 | 55.6% | [47.9%, 63.1%] | 160 | 21350 | 976 | 8.1s | 0.0% | 0.0% |

## Accuracy by arm × category

| Arm | Category | Accuracy | 95% CI | n |
|-----|----------|----------|--------|---|
| textmap2 | coverage | 95.0% | [76.4%, 99.1%] | 20 |
| textmap2 | nearest | 100.0% | [83.9%, 100.0%] | 20 |
| textmap2 | mixed | 38.3% | [27.1%, 51.0%] | 60 |
| textmap2 | containment | 100.0% | [83.9%, 100.0%] | 20 |
| textmap2 | crossing | 35.0% | [18.1%, 56.7%] | 20 |
| textmap2 | line-intersection | 0.0% | [-0.0%, 16.1%] | 20 |

## Pairwise comparison (McNemar, paired)

| Arm A | Arm B | acc A | acc B | b | c | χ² | p |
|-------|-------|-------|-------|---|---|----|---|

_b = A correct & B wrong; c = A wrong & B correct. p<0.05 ⇒ the arms differ significantly._
