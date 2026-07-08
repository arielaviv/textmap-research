# Spatial-Representation Eval — Results

Config: {"source":"real","city":"nyc","n":20,"models":["claude-haiku-4-5-20251001"],"arms":["json","textmap2"],"temperature":0,"repeats":3,"seed":1000,"isolate":true,"questionIds":null,"scale":null,"totalCalls":1200}

Total items: 1200 (errors: 0)


## Accuracy by arm (95% Wilson CI)

| Arm | Accuracy | 95% CI | n | avg in-tok | avg out-tok | avg latency | halluc. | missing-info |
|-----|----------|--------|---|-----------|------------|--------|---------|--------------|
| json | 40.2% | [36.3%, 44.1%] | 600 | 9967 | 41 | 1.2s | 0.0% | 0.0% |
| textmap2 | 40.2% | [36.3%, 44.1%] | 600 | 6598 | 47 | 1.2s | 0.0% | 0.0% |

## Accuracy by arm × category

| Arm | Category | Accuracy | 95% CI | n |
|-----|----------|----------|--------|---|
| json | nearest | 95.0% | [86.3%, 98.3%] | 60 |
| json | coverage | 38.3% | [27.1%, 51.0%] | 60 |
| json | on-street | 50.0% | [37.7%, 62.3%] | 60 |
| json | containment | 58.3% | [45.7%, 69.9%] | 60 |
| json | crossing | 45.0% | [33.1%, 57.5%] | 60 |
| json | path | 100.0% | [94.0%, 100.0%] | 60 |
| json | mixed | 5.0% | [2.7%, 9.2%] | 180 |
| json | line-intersection | 0.0% | [-0.0%, 6.0%] | 60 |
| textmap2 | nearest | 95.0% | [86.3%, 98.3%] | 60 |
| textmap2 | coverage | 25.0% | [15.8%, 37.2%] | 60 |
| textmap2 | on-street | 100.0% | [94.0%, 100.0%] | 60 |
| textmap2 | containment | 95.0% | [86.3%, 98.3%] | 60 |
| textmap2 | crossing | 5.0% | [1.7%, 13.7%] | 60 |
| textmap2 | path | 60.0% | [47.4%, 71.4%] | 60 |
| textmap2 | mixed | 7.2% | [4.3%, 12.0%] | 180 |
| textmap2 | line-intersection | 0.0% | [-0.0%, 6.0%] | 60 |

## Pairwise comparison (McNemar, paired)

| Arm A | Arm B | acc A | acc B | b | c | χ² | p |
|-------|-------|-------|-------|---|---|----|---|
| json | textmap2 | 40.2% | 40.2% | 67 | 67 | 0.01 | 0.9312 |

_b = A correct & B wrong; c = A wrong & B correct. p<0.05 ⇒ the arms differ significantly._
