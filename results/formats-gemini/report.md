# Spatial-Representation Eval — Results

Config: {"source":"real","city":"nyc","n":20,"models":["google/gemini-2.5-pro"],"arms":["wkt","image"],"temperature":0,"repeats":1,"seed":1000,"isolate":true,"questionIds":null,"scale":null,"totalCalls":400}

Total items: 400 (errors: 25)


## Accuracy by arm (95% Wilson CI)

| Arm | Accuracy | 95% CI | n | avg in-tok | avg out-tok | avg latency | halluc. | missing-info |
|-----|----------|--------|---|-----------|------------|--------|---------|--------------|
| image | 7.0% | [4.2%, 11.4%] | 200 | 1925 | 733 | 9.8s | 65.0% | 6.0% |
| wkt | 27.5% | [21.8%, 34.1%] | 200 | 12479 | 749 | 9.3s | 0.0% | 2.5% |

## Accuracy by arm × category

| Arm | Category | Accuracy | 95% CI | n |
|-----|----------|----------|--------|---|
| image | on-street | 20.0% | [8.1%, 41.6%] | 20 |
| image | path | 0.0% | [-0.0%, 16.1%] | 20 |
| image | nearest | 0.0% | [-0.0%, 16.1%] | 20 |
| image | containment | 0.0% | [-0.0%, 16.1%] | 20 |
| image | mixed | 0.0% | [-0.0%, 6.0%] | 60 |
| image | crossing | 15.0% | [5.2%, 36.0%] | 20 |
| image | line-intersection | 0.0% | [-0.0%, 16.1%] | 20 |
| image | coverage | 35.0% | [18.1%, 56.7%] | 20 |
| wkt | on-street | 65.0% | [43.3%, 81.9%] | 20 |
| wkt | path | 10.0% | [2.8%, 30.1%] | 20 |
| wkt | nearest | 90.0% | [69.9%, 97.2%] | 20 |
| wkt | containment | 20.0% | [8.1%, 41.6%] | 20 |
| wkt | mixed | 11.7% | [5.8%, 22.2%] | 60 |
| wkt | crossing | 0.0% | [-0.0%, 16.1%] | 20 |
| wkt | line-intersection | 0.0% | [-0.0%, 16.1%] | 20 |
| wkt | coverage | 55.0% | [34.2%, 74.2%] | 20 |

## Pairwise comparison (McNemar, paired)

| Arm A | Arm B | acc A | acc B | b | c | χ² | p |
|-------|-------|-------|-------|---|---|----|---|
| image | wkt | 7.0% | 27.5% | 5 | 46 | 31.37 | 0.0000 |

_b = A correct & B wrong; c = A wrong & B correct. p<0.05 ⇒ the arms differ significantly._
