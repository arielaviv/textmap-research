# Spatial-Representation Eval — Results

Config: {"source":"real","city":"nyc","n":60,"models":["anthropic/claude-haiku-4.5"],"arms":["json","textmap2"],"temperature":0,"repeats":1,"seed":1000,"isolate":true,"questionIds":["holdout"],"scale":null,"totalCalls":720}

Total items: 720 (errors: 0)


## Accuracy by arm (95% Wilson CI)

| Arm | Accuracy | 95% CI | n | avg in-tok | avg out-tok | avg latency | halluc. | missing-info |
|-----|----------|--------|---|-----------|------------|--------|---------|--------------|
| textmap2 | 48.3% | [43.2%, 53.5%] | 360 | 6874 | 38 | 1.2s | 0.0% | 0.0% |
| json | 43.1% | [38.0%, 48.2%] | 360 | 10104 | 38 | 1.3s | 0.0% | 0.0% |

## Accuracy by arm × category

| Arm | Category | Accuracy | 95% CI | n |
|-----|----------|----------|--------|---|
| textmap2 | holdout | 48.3% | [43.2%, 53.5%] | 360 |
| json | holdout | 43.1% | [38.0%, 48.2%] | 360 |

## Pairwise comparison (McNemar, paired)

| Arm A | Arm B | acc A | acc B | b | c | χ² | p |
|-------|-------|-------|-------|---|---|----|---|
| textmap2 | json | 48.3% | 43.1% | 52 | 33 | 3.81 | 0.0509 |

_b = A correct & B wrong; c = A wrong & B correct. p<0.05 ⇒ the arms differ significantly._
