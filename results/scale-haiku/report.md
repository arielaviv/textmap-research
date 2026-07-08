# Spatial-Representation Eval — Results

Config: {"source":"real","city":"nyc","n":3,"models":["claude-haiku-4-5-20251001"],"arms":["json","textmap2"],"temperature":0,"repeats":1,"seed":1000,"isolate":true,"questionIds":null,"scale":[350,700,1400,2800],"totalCalls":240}

Total items: 240 (errors: 0)


## Accuracy by arm (95% Wilson CI)

| Arm | Accuracy | 95% CI | n | avg in-tok | avg out-tok | avg latency | halluc. | missing-info |
|-----|----------|--------|---|-----------|------------|--------|---------|--------------|
| textmap2 | 45.0% | [36.4%, 53.9%] | 120 | 8061 | 54 | 1.2s | 0.0% | 0.0% |
| json | 40.8% | [32.5%, 49.8%] | 120 | 13943 | 43 | 1.2s | 0.0% | 0.0% |

## Scale sweep — accuracy vs tokens by AOI size

| Scale | Arm | Accuracy | 95% CI | n | avg in-tok | avg latency |
|-------|-----|----------|--------|---|-----------|--------|
| 350m | textmap2 | 43.3% | [27.4%, 60.8%] | 30 | 6700 | 1.1s |
| 350m | json | 33.3% | [19.2%, 51.2%] | 30 | 9498 | 1.3s |
| 700m | textmap2 | 56.7% | [39.2%, 72.6%] | 30 | 7446 | 1.1s |
| 700m | json | 50.0% | [33.2%, 66.8%] | 30 | 13221 | 1.2s |
| 1400m | textmap2 | 40.0% | [24.6%, 57.7%] | 30 | 8405 | 1.1s |
| 1400m | json | 40.0% | [24.6%, 57.7%] | 30 | 14655 | 1.1s |
| 2800m | textmap2 | 40.0% | [24.6%, 57.7%] | 30 | 9694 | 1.6s |
| 2800m | json | 40.0% | [24.6%, 57.7%] | 30 | 18398 | 1.3s |

## Accuracy by arm × category

| Arm | Category | Accuracy | 95% CI | n |
|-----|----------|----------|--------|---|
| textmap2 | coverage | 8.3% | [1.5%, 35.4%] | 12 |
| textmap2 | containment | 75.0% | [46.8%, 91.1%] | 12 |
| textmap2 | path | 83.3% | [55.2%, 95.3%] | 12 |
| textmap2 | nearest | 100.0% | [75.7%, 100.0%] | 12 |
| textmap2 | on-street | 91.7% | [64.6%, 98.5%] | 12 |
| textmap2 | crossing | 16.7% | [4.7%, 44.8%] | 12 |
| textmap2 | line-intersection | 0.0% | [0.0%, 24.3%] | 12 |
| textmap2 | mixed | 25.0% | [13.8%, 41.1%] | 36 |
| json | coverage | 16.7% | [4.7%, 44.8%] | 12 |
| json | containment | 66.7% | [39.1%, 86.2%] | 12 |
| json | path | 100.0% | [75.7%, 100.0%] | 12 |
| json | nearest | 100.0% | [75.7%, 100.0%] | 12 |
| json | on-street | 50.0% | [25.4%, 74.6%] | 12 |
| json | crossing | 41.7% | [19.3%, 68.0%] | 12 |
| json | line-intersection | 0.0% | [0.0%, 24.3%] | 12 |
| json | mixed | 11.1% | [4.4%, 25.3%] | 36 |

## Pairwise comparison (McNemar, paired)

| Arm A | Arm B | acc A | acc B | b | c | χ² | p |
|-------|-------|-------|-------|---|---|----|---|
| textmap2 | json | 45.0% | 40.8% | 14 | 9 | 0.70 | 0.4042 |

_b = A correct & B wrong; c = A wrong & B correct. p<0.05 ⇒ the arms differ significantly._
