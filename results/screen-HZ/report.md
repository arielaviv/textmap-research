# Spatial-Representation Eval — Results

Config: {"source":"real","city":"nyc","n":20,"models":["anthropic/claude-haiku-4.5"],"arms":["textmap2"],"temperature":0,"repeats":1,"seed":1000,"isolate":true,"questionIds":null,"scale":null,"hints":true,"votes":1,"turns":1,"totalCalls":200}

Total items: 200 (errors: 0)


## Accuracy by arm (95% Wilson CI)

| Arm | Accuracy | 95% CI | n | avg in-tok | avg out-tok | avg latency | halluc. | missing-info |
|-----|----------|--------|---|-----------|------------|--------|---------|--------------|
| textmap2 | 52.0% | [45.1%, 58.8%] | 200 | 10705 | 45 | 1.5s | 0.0% | 0.0% |

## Accuracy by arm × category

| Arm | Category | Accuracy | 95% CI | n |
|-----|----------|----------|--------|---|
| textmap2 | crossing | 30.0% | [14.5%, 51.9%] | 20 |
| textmap2 | coverage | 50.0% | [29.9%, 70.1%] | 20 |
| textmap2 | nearest | 100.0% | [83.9%, 100.0%] | 20 |
| textmap2 | mixed | 23.3% | [14.4%, 35.4%] | 60 |
| textmap2 | on-street | 85.0% | [64.0%, 94.8%] | 20 |
| textmap2 | path | 100.0% | [83.9%, 100.0%] | 20 |
| textmap2 | containment | 85.0% | [64.0%, 94.8%] | 20 |
| textmap2 | line-intersection | 0.0% | [-0.0%, 16.1%] | 20 |

## Pairwise comparison (McNemar, paired)

| Arm A | Arm B | acc A | acc B | b | c | χ² | p |
|-------|-------|-------|-------|---|---|----|---|

_b = A correct & B wrong; c = A wrong & B correct. p<0.05 ⇒ the arms differ significantly._
