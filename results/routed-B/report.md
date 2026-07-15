# Spatial-Representation Eval — Results

Config: {"source":"real","city":"nyc","n":20,"models":["anthropic/claude-haiku-4.5"],"arms":["textmap2"],"temperature":0,"repeats":1,"seed":2000,"isolate":true,"questionIds":["path","on-street"],"scale":null,"hints":true,"votes":1,"turns":1,"totalCalls":40}

Total items: 40 (errors: 5)


## Accuracy by arm (95% Wilson CI)

| Arm | Accuracy | 95% CI | n | avg in-tok | avg out-tok | avg latency | halluc. | missing-info |
|-----|----------|--------|---|-----------|------------|--------|---------|--------------|
| textmap2 | 85.0% | [70.9%, 92.9%] | 40 | 6083 | 35 | 1.2s | 0.0% | 0.0% |

## Accuracy by arm × category

| Arm | Category | Accuracy | 95% CI | n |
|-----|----------|----------|--------|---|
| textmap2 | on-street | 85.0% | [64.0%, 94.8%] | 20 |
| textmap2 | path | 85.0% | [64.0%, 94.8%] | 20 |

## Pairwise comparison (McNemar, paired)

| Arm A | Arm B | acc A | acc B | b | c | χ² | p |
|-------|-------|-------|-------|---|---|----|---|

_b = A correct & B wrong; c = A wrong & B correct. p<0.05 ⇒ the arms differ significantly._
