# Spatial-Representation Eval — Results

Config: {"source":"real","city":"nyc","n":20,"models":["claude-haiku-4-5-20251001"],"arms":["json","textmap2"],"temperature":0,"repeats":3,"seed":1000,"isolate":true,"questionIds":null,"scale":null,"totalCalls":1200}

Total items: 1200 (errors: 0)


## Accuracy by arm (95% Wilson CI)

| Arm | Accuracy | 95% CI | n | avg in-tok | avg out-tok | avg latency | halluc. | missing-info |
|-----|----------|--------|---|-----------|------------|--------|---------|--------------|
| json | 37.5% | [33.7%, 41.4%] | 600 | 9971 | 41 | 1.1s | 0.0% | 0.0% |
| textmap2 | 44.3% | [40.4%, 48.3%] | 600 | 6720 | 47 | 1.2s | 1.0% | 0.0% |

## Accuracy by arm × category

| Arm | Category | Accuracy | 95% CI | n |
|-----|----------|----------|--------|---|
| json | nearest | 100.0% | [94.0%, 100.0%] | 60 |
| json | path | 100.0% | [94.0%, 100.0%] | 60 |
| json | containment | 15.0% | [8.1%, 26.1%] | 60 |
| json | crossing | 45.0% | [33.1%, 57.5%] | 60 |
| json | coverage | 50.0% | [37.7%, 62.3%] | 60 |
| json | on-street | 60.0% | [47.4%, 71.4%] | 60 |
| json | line-intersection | 0.0% | [-0.0%, 6.0%] | 60 |
| json | mixed | 1.7% | [0.6%, 4.8%] | 180 |
| textmap2 | nearest | 95.0% | [86.3%, 98.3%] | 60 |
| textmap2 | path | 95.0% | [86.3%, 98.3%] | 60 |
| textmap2 | containment | 83.3% | [72.0%, 90.7%] | 60 |
| textmap2 | crossing | 10.0% | [4.7%, 20.1%] | 60 |
| textmap2 | coverage | 30.0% | [19.9%, 42.5%] | 60 |
| textmap2 | on-street | 25.0% | [15.8%, 37.2%] | 60 |
| textmap2 | line-intersection | 0.0% | [-0.0%, 6.0%] | 60 |
| textmap2 | mixed | 35.0% | [28.4%, 42.2%] | 180 |

## Pairwise comparison (McNemar, paired)

| Arm A | Arm B | acc A | acc B | b | c | χ² | p |
|-------|-------|-------|-------|---|---|----|---|
| json | textmap2 | 37.5% | 44.3% | 72 | 113 | 8.65 | 0.0033 |

_b = A correct & B wrong; c = A wrong & B correct. p<0.05 ⇒ the arms differ significantly._
