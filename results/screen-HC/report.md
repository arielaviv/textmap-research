# Spatial-Representation Eval — Results

Config: {"source":"real","city":"nyc","n":20,"models":["anthropic/claude-haiku-4.5"],"arms":["textmap2"],"temperature":0,"repeats":1,"seed":1000,"isolate":true,"questionIds":null,"scale":null,"hints":true,"votes":1,"turns":1,"totalCalls":200}

Total items: 200 (errors: 0)


## Accuracy by arm (95% Wilson CI)

| Arm | Accuracy | 95% CI | n | avg in-tok | avg out-tok | avg latency | halluc. | missing-info |
|-----|----------|--------|---|-----------|------------|--------|---------|--------------|
| textmap2 | 49.0% | [42.2%, 55.9%] | 200 | 6989 | 232 | 2.5s | 0.5% | 0.0% |

## Accuracy by arm × category

| Arm | Category | Accuracy | 95% CI | n |
|-----|----------|----------|--------|---|
| textmap2 | crossing | 30.0% | [14.5%, 51.9%] | 20 |
| textmap2 | coverage | 35.0% | [18.1%, 56.7%] | 20 |
| textmap2 | on-street | 90.0% | [69.9%, 97.2%] | 20 |
| textmap2 | mixed | 20.0% | [11.8%, 31.8%] | 60 |
| textmap2 | nearest | 100.0% | [83.9%, 100.0%] | 20 |
| textmap2 | line-intersection | 0.0% | [-0.0%, 16.1%] | 20 |
| textmap2 | path | 100.0% | [83.9%, 100.0%] | 20 |
| textmap2 | containment | 75.0% | [53.1%, 88.8%] | 20 |

## Pairwise comparison (McNemar, paired)

| Arm A | Arm B | acc A | acc B | b | c | χ² | p |
|-------|-------|-------|-------|---|---|----|---|

_b = A correct & B wrong; c = A wrong & B correct. p<0.05 ⇒ the arms differ significantly._
