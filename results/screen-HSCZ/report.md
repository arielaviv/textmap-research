# Spatial-Representation Eval — Results

Config: {"source":"real","city":"nyc","n":20,"models":["anthropic/claude-haiku-4.5"],"arms":["textmap2"],"temperature":0,"repeats":1,"seed":1000,"isolate":true,"questionIds":null,"scale":null,"hints":true,"votes":1,"turns":1,"totalCalls":200}

Total items: 200 (errors: 0)


## Accuracy by arm (95% Wilson CI)

| Arm | Accuracy | 95% CI | n | avg in-tok | avg out-tok | avg latency | halluc. | missing-info |
|-----|----------|--------|---|-----------|------------|--------|---------|--------------|
| textmap2 | 56.0% | [49.1%, 62.7%] | 200 | 21327 | 952 | 8.5s | 0.0% | 0.5% |

## Accuracy by arm × category

| Arm | Category | Accuracy | 95% CI | n |
|-----|----------|----------|--------|---|
| textmap2 | coverage | 95.0% | [76.4%, 99.1%] | 20 |
| textmap2 | on-street | 70.0% | [48.1%, 85.5%] | 20 |
| textmap2 | mixed | 40.0% | [28.6%, 52.6%] | 60 |
| textmap2 | crossing | 50.0% | [29.9%, 70.1%] | 20 |
| textmap2 | containment | 95.0% | [76.4%, 99.1%] | 20 |
| textmap2 | nearest | 100.0% | [83.9%, 100.0%] | 20 |
| textmap2 | line-intersection | 15.0% | [5.2%, 36.0%] | 20 |
| textmap2 | path | 15.0% | [5.2%, 36.0%] | 20 |

## Pairwise comparison (McNemar, paired)

| Arm A | Arm B | acc A | acc B | b | c | χ² | p |
|-------|-------|-------|-------|---|---|----|---|

_b = A correct & B wrong; c = A wrong & B correct. p<0.05 ⇒ the arms differ significantly._
