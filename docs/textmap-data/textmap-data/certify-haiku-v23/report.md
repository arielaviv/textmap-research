# Spatial-Representation Eval — Results

Config: {"source":"real","city":"nyc","n":60,"models":["claude-haiku-4-5-20251001"],"arms":["json","textmap2"],"temperature":0,"repeats":1,"seed":1000,"isolate":true,"questionIds":null,"scale":null,"totalCalls":1200}

Total items: 1200 (errors: 0)


## Accuracy by arm (95% Wilson CI)

| Arm | Accuracy | 95% CI | n | avg in-tok | avg out-tok | avg latency | halluc. | missing-info |
|-----|----------|--------|---|-----------|------------|--------|---------|--------------|
| textmap2 | 47.0% | [43.0%, 51.0%] | 600 | 6739 | 48 | 1.2s | 0.8% | 0.0% |
| json | 38.7% | [34.9%, 42.6%] | 600 | 10025 | 41 | 1.2s | 0.0% | 0.0% |

## Accuracy by arm × category

| Arm | Category | Accuracy | 95% CI | n |
|-----|----------|----------|--------|---|
| textmap2 | coverage | 41.7% | [30.1%, 54.3%] | 60 |
| textmap2 | on-street | 71.7% | [59.2%, 81.5%] | 60 |
| textmap2 | nearest | 93.3% | [84.1%, 97.4%] | 60 |
| textmap2 | path | 93.3% | [84.1%, 97.4%] | 60 |
| textmap2 | mixed | 28.9% | [22.8%, 35.9%] | 180 |
| textmap2 | line-intersection | 3.3% | [0.9%, 11.4%] | 60 |
| textmap2 | crossing | 15.0% | [8.1%, 26.1%] | 60 |
| textmap2 | containment | 65.0% | [52.4%, 75.8%] | 60 |
| json | coverage | 48.3% | [36.2%, 60.7%] | 60 |
| json | on-street | 60.0% | [47.4%, 71.4%] | 60 |
| json | nearest | 100.0% | [94.0%, 100.0%] | 60 |
| json | path | 100.0% | [94.0%, 100.0%] | 60 |
| json | mixed | 10.0% | [6.4%, 15.3%] | 180 |
| json | line-intersection | 3.3% | [0.9%, 11.4%] | 60 |
| json | crossing | 38.3% | [27.1%, 51.0%] | 60 |
| json | containment | 6.7% | [2.6%, 15.9%] | 60 |

## Pairwise comparison (McNemar, paired)

| Arm A | Arm B | acc A | acc B | b | c | χ² | p |
|-------|-------|-------|-------|---|---|----|---|
| textmap2 | json | 47.0% | 38.7% | 108 | 58 | 14.46 | 0.0001 |

_b = A correct & B wrong; c = A wrong & B correct. p<0.05 ⇒ the arms differ significantly._
