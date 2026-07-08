# Spatial-Representation Eval — Results

Config: {"source":"real","city":"nyc","n":20,"models":["claude-haiku-4-5-20251001"],"arms":["verdict"],"temperature":0,"repeats":1,"seed":1000,"isolate":true,"questionIds":null,"scale":null,"totalCalls":200}

Total items: 200 (errors: 0)


## Accuracy by arm (95% Wilson CI)

| Arm | Accuracy | 95% CI | n | avg in-tok | avg out-tok | avg latency | halluc. | missing-info |
|-----|----------|--------|---|-----------|------------|--------|---------|--------------|
| verdict | 61.5% | [54.6%, 68.0%] | 200 | 2218 | 40 | 1.1s | 0.0% | 0.0% |

## Accuracy by arm × category

| Arm | Category | Accuracy | 95% CI | n |
|-----|----------|----------|--------|---|
| verdict | crossing | 100.0% | [83.9%, 100.0%] | 20 |
| verdict | nearest | 100.0% | [83.9%, 100.0%] | 20 |
| verdict | coverage | 90.0% | [69.9%, 97.2%] | 20 |
| verdict | on-street | 100.0% | [83.9%, 100.0%] | 20 |
| verdict | mixed | 8.3% | [3.6%, 18.1%] | 60 |
| verdict | containment | 100.0% | [83.9%, 100.0%] | 20 |
| verdict | path | 100.0% | [83.9%, 100.0%] | 20 |
| verdict | line-intersection | 0.0% | [-0.0%, 16.1%] | 20 |

## Pairwise comparison (McNemar, paired)

| Arm A | Arm B | acc A | acc B | b | c | χ² | p |
|-------|-------|-------|-------|---|---|----|---|

_b = A correct & B wrong; c = A wrong & B correct. p<0.05 ⇒ the arms differ significantly._
