# Spatial-Representation Eval — Results

Config: {"source":"real","city":"nyc","n":20,"models":["anthropic/claude-haiku-4.5"],"arms":["textmap2"],"temperature":0,"repeats":1,"seed":1000,"isolate":true,"questionIds":null,"scale":null,"hints":true,"votes":5,"turns":5,"totalCalls":5000}

Total items: 200 (errors: 0)


## Accuracy by arm (95% Wilson CI)

| Arm | Accuracy | 95% CI | n | avg in-tok | avg out-tok | avg latency | halluc. | missing-info |
|-----|----------|--------|---|-----------|------------|--------|---------|--------------|
| textmap2 | 53.0% | [46.1%, 59.8%] | 200 | 67336 | 1710 | 17.1s | 0.0% | 0.0% |

## Accuracy by arm × category

| Arm | Category | Accuracy | 95% CI | n |
|-----|----------|----------|--------|---|
| textmap2 | coverage | 95.0% | [76.4%, 99.1%] | 20 |
| textmap2 | on-street | 70.0% | [48.1%, 85.5%] | 20 |
| textmap2 | crossing | 40.0% | [21.9%, 61.3%] | 20 |
| textmap2 | mixed | 40.0% | [28.6%, 52.6%] | 60 |
| textmap2 | nearest | 100.0% | [83.9%, 100.0%] | 20 |
| textmap2 | path | 10.0% | [2.8%, 30.1%] | 20 |
| textmap2 | line-intersection | 5.0% | [0.9%, 23.6%] | 20 |
| textmap2 | containment | 90.0% | [69.9%, 97.2%] | 20 |

## Pairwise comparison (McNemar, paired)

| Arm A | Arm B | acc A | acc B | b | c | χ² | p |
|-------|-------|-------|-------|---|---|----|---|

_b = A correct & B wrong; c = A wrong & B correct. p<0.05 ⇒ the arms differ significantly._
