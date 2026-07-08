# Spatial-Representation Eval — Results

Config: {"source":"real","city":"nyc","n":20,"models":["claude-sonnet-4-6"],"arms":["json","textmap2"],"temperature":0,"repeats":1,"seed":1000,"isolate":true,"questionIds":null,"scale":null,"totalCalls":400}

Total items: 400 (errors: 0)


## Accuracy by arm (95% Wilson CI)

| Arm | Accuracy | 95% CI | n | avg in-tok | avg out-tok | avg latency | halluc. | missing-info |
|-----|----------|--------|---|-----------|------------|--------|---------|--------------|
| json | 38.5% | [32.0%, 45.4%] | 200 | 9972 | 41 | 1.7s | 0.0% | 6.5% |
| textmap2 | 56.5% | [49.6%, 63.2%] | 200 | 6690 | 45 | 1.9s | 0.0% | 0.0% |

## Accuracy by arm × category

| Arm | Category | Accuracy | 95% CI | n |
|-----|----------|----------|--------|---|
| json | nearest | 95.0% | [76.4%, 99.1%] | 20 |
| json | coverage | 60.0% | [38.7%, 78.1%] | 20 |
| json | path | 100.0% | [83.9%, 100.0%] | 20 |
| json | crossing | 45.0% | [25.8%, 65.8%] | 20 |
| json | mixed | 1.7% | [0.3%, 8.9%] | 60 |
| json | containment | 20.0% | [8.1%, 41.6%] | 20 |
| json | on-street | 60.0% | [38.7%, 78.1%] | 20 |
| json | line-intersection | 0.0% | [-0.0%, 16.1%] | 20 |
| textmap2 | nearest | 90.0% | [69.9%, 97.2%] | 20 |
| textmap2 | coverage | 60.0% | [38.7%, 78.1%] | 20 |
| textmap2 | path | 85.0% | [64.0%, 94.8%] | 20 |
| textmap2 | crossing | 15.0% | [5.2%, 36.0%] | 20 |
| textmap2 | mixed | 45.0% | [33.1%, 57.5%] | 60 |
| textmap2 | containment | 100.0% | [83.9%, 100.0%] | 20 |
| textmap2 | on-street | 80.0% | [58.4%, 91.9%] | 20 |
| textmap2 | line-intersection | 0.0% | [-0.0%, 16.1%] | 20 |

## Pairwise comparison (McNemar, paired)

| Arm A | Arm B | acc A | acc B | b | c | χ² | p |
|-------|-------|-------|-------|---|---|----|---|
| json | textmap2 | 38.5% | 56.5% | 13 | 49 | 19.76 | 0.0000 |

_b = A correct & B wrong; c = A wrong & B correct. p<0.05 ⇒ the arms differ significantly._
