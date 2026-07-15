# Spatial-Representation Eval — Results

Config: {"source":"real","city":"nyc","n":20,"models":["anthropic/claude-haiku-4.5"],"arms":["textmap2"],"temperature":0,"repeats":1,"seed":1000,"isolate":true,"questionIds":null,"scale":null,"hints":true,"votes":1,"turns":1,"totalCalls":200}

Total items: 200 (errors: 0)


## Accuracy by arm (95% Wilson CI)

| Arm | Accuracy | 95% CI | n | avg in-tok | avg out-tok | avg latency | halluc. | missing-info |
|-----|----------|--------|---|-----------|------------|--------|---------|--------------|
| textmap2 | 53.0% | [46.1%, 59.8%] | 200 | 21291 | 811 | 7.6s | 1.5% | 0.0% |

## Accuracy by arm × category

| Arm | Category | Accuracy | 95% CI | n |
|-----|----------|----------|--------|---|
| textmap2 | coverage | 95.0% | [76.4%, 99.1%] | 20 |
| textmap2 | nearest | 95.0% | [76.4%, 99.1%] | 20 |
| textmap2 | containment | 95.0% | [76.4%, 99.1%] | 20 |
| textmap2 | on-street | 75.0% | [53.1%, 88.8%] | 20 |
| textmap2 | mixed | 36.7% | [25.6%, 49.3%] | 60 |
| textmap2 | crossing | 45.0% | [25.8%, 65.8%] | 20 |
| textmap2 | path | 5.0% | [0.9%, 23.6%] | 20 |
| textmap2 | line-intersection | 10.0% | [2.8%, 30.1%] | 20 |

## Pairwise comparison (McNemar, paired)

| Arm A | Arm B | acc A | acc B | b | c | χ² | p |
|-------|-------|-------|-------|---|---|----|---|

_b = A correct & B wrong; c = A wrong & B correct. p<0.05 ⇒ the arms differ significantly._
