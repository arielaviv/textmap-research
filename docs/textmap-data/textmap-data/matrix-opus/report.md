# Spatial-Representation Eval — Results

Config: {"source":"real","city":"nyc","n":20,"models":["claude-opus-4-8"],"arms":["json","textmap2"],"temperature":0,"repeats":1,"seed":1000,"isolate":true,"questionIds":null,"scale":null,"totalCalls":400}

Total items: 400 (errors: 0)


## Accuracy by arm (95% Wilson CI)

| Arm | Accuracy | 95% CI | n | avg in-tok | avg out-tok | avg latency | halluc. | missing-info |
|-----|----------|--------|---|-----------|------------|--------|---------|--------------|
| json | 34.5% | [28.3%, 41.3%] | 200 | 11649 | 44 | 2.1s | 1.0% | 1.5% |
| textmap2 | 64.5% | [57.7%, 70.8%] | 200 | 7197 | 49 | 2.2s | 0.0% | 2.5% |

## Accuracy by arm × category

| Arm | Category | Accuracy | 95% CI | n |
|-----|----------|----------|--------|---|
| json | mixed | 3.3% | [0.9%, 11.4%] | 60 |
| json | on-street | 30.0% | [14.5%, 51.9%] | 20 |
| json | crossing | 50.0% | [29.9%, 70.1%] | 20 |
| json | nearest | 90.0% | [69.9%, 97.2%] | 20 |
| json | line-intersection | 0.0% | [-0.0%, 16.1%] | 20 |
| json | coverage | 60.0% | [38.7%, 78.1%] | 20 |
| json | containment | 20.0% | [8.1%, 41.6%] | 20 |
| json | path | 85.0% | [64.0%, 94.8%] | 20 |
| textmap2 | mixed | 45.0% | [33.1%, 57.5%] | 60 |
| textmap2 | on-street | 100.0% | [83.9%, 100.0%] | 20 |
| textmap2 | crossing | 40.0% | [21.9%, 61.3%] | 20 |
| textmap2 | nearest | 95.0% | [76.4%, 99.1%] | 20 |
| textmap2 | line-intersection | 5.0% | [0.9%, 23.6%] | 20 |
| textmap2 | coverage | 95.0% | [76.4%, 99.1%] | 20 |
| textmap2 | containment | 100.0% | [83.9%, 100.0%] | 20 |
| textmap2 | path | 75.0% | [53.1%, 88.8%] | 20 |

## Pairwise comparison (McNemar, paired)

| Arm A | Arm B | acc A | acc B | b | c | χ² | p |
|-------|-------|-------|-------|---|---|----|---|
| json | textmap2 | 34.5% | 64.5% | 4 | 64 | 51.19 | 0.0000 |

_b = A correct & B wrong; c = A wrong & B correct. p<0.05 ⇒ the arms differ significantly._
