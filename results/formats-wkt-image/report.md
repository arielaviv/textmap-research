# Spatial-Representation Eval — Results

Config: {"source":"real","city":"nyc","n":60,"models":["anthropic/claude-haiku-4.5"],"arms":["wkt","image"],"temperature":0,"repeats":1,"seed":1000,"isolate":true,"questionIds":null,"scale":null,"totalCalls":1200}

Total items: 1200 (errors: 0)


## Accuracy by arm (95% Wilson CI)

| Arm | Accuracy | 95% CI | n | avg in-tok | avg out-tok | avg latency | halluc. | missing-info |
|-----|----------|--------|---|-----------|------------|--------|---------|--------------|
| wkt | 36.5% | [32.7%, 40.4%] | 600 | 9221 | 40 | 1.4s | 0.0% | 0.0% |
| image | 18.7% | [15.8%, 22.0%] | 600 | 2630 | 38 | 1.5s | 32.0% | 0.0% |

## Accuracy by arm × category

| Arm | Category | Accuracy | 95% CI | n |
|-----|----------|----------|--------|---|
| wkt | nearest | 96.7% | [88.6%, 99.1%] | 60 |
| wkt | crossing | 38.3% | [27.1%, 51.0%] | 60 |
| wkt | on-street | 70.0% | [57.5%, 80.1%] | 60 |
| wkt | mixed | 7.8% | [4.7%, 12.6%] | 180 |
| wkt | coverage | 25.0% | [15.8%, 37.2%] | 60 |
| wkt | line-intersection | 1.7% | [0.3%, 8.9%] | 60 |
| wkt | path | 100.0% | [94.0%, 100.0%] | 60 |
| wkt | containment | 10.0% | [4.7%, 20.1%] | 60 |
| image | nearest | 0.0% | [-0.0%, 6.0%] | 60 |
| image | crossing | 40.0% | [28.6%, 52.6%] | 60 |
| image | on-street | 73.3% | [61.0%, 82.9%] | 60 |
| image | mixed | 0.0% | [0.0%, 2.1%] | 180 |
| image | coverage | 65.0% | [52.4%, 75.8%] | 60 |
| image | line-intersection | 0.0% | [-0.0%, 6.0%] | 60 |
| image | path | 0.0% | [-0.0%, 6.0%] | 60 |
| image | containment | 8.3% | [3.6%, 18.1%] | 60 |

## Pairwise comparison (McNemar, paired)

| Arm A | Arm B | acc A | acc B | b | c | χ² | p |
|-------|-------|-------|-------|---|---|----|---|
| wkt | image | 36.5% | 18.7% | 155 | 48 | 55.35 | 0.0000 |

_b = A correct & B wrong; c = A wrong & B correct. p<0.05 ⇒ the arms differ significantly._
