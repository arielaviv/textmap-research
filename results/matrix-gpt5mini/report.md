# Spatial-Representation Eval — Results

Config: {"source":"real","city":"nyc","n":20,"models":["openai/gpt-5-mini"],"arms":["json","textmap2"],"temperature":0,"repeats":1,"seed":1000,"isolate":true,"questionIds":null,"scale":null,"totalCalls":400}

Total items: 400 (errors: 25)


## Accuracy by arm (95% Wilson CI)

| Arm | Accuracy | 95% CI | n | avg in-tok | avg out-tok | avg latency | halluc. | missing-info |
|-----|----------|--------|---|-----------|------------|--------|---------|--------------|
| json | 37.5% | [31.1%, 44.4%] | 200 | 8553 | 6375 | 115.6s | 1.5% | 10.5% |
| textmap2 | 47.5% | [40.7%, 54.4%] | 200 | 5392 | 5568 | 150.4s | 1.0% | 7.5% |

## Accuracy by arm × category

| Arm | Category | Accuracy | 95% CI | n |
|-----|----------|----------|--------|---|
| json | path | 75.0% | [53.1%, 88.8%] | 20 |
| json | containment | 0.0% | [-0.0%, 16.1%] | 20 |
| json | nearest | 70.0% | [48.1%, 85.5%] | 20 |
| json | on-street | 30.0% | [14.5%, 51.9%] | 20 |
| json | coverage | 55.0% | [34.2%, 74.2%] | 20 |
| json | crossing | 30.0% | [14.5%, 51.9%] | 20 |
| json | mixed | 31.7% | [21.3%, 44.2%] | 60 |
| json | line-intersection | 20.0% | [8.1%, 41.6%] | 20 |
| textmap2 | path | 20.0% | [8.1%, 41.6%] | 20 |
| textmap2 | containment | 65.0% | [43.3%, 81.9%] | 20 |
| textmap2 | nearest | 85.0% | [64.0%, 94.8%] | 20 |
| textmap2 | on-street | 70.0% | [48.1%, 85.5%] | 20 |
| textmap2 | coverage | 65.0% | [43.3%, 81.9%] | 20 |
| textmap2 | crossing | 30.0% | [14.5%, 51.9%] | 20 |
| textmap2 | mixed | 41.7% | [30.1%, 54.3%] | 60 |
| textmap2 | line-intersection | 15.0% | [5.2%, 36.0%] | 20 |

## Pairwise comparison (McNemar, paired)

| Arm A | Arm B | acc A | acc B | b | c | χ² | p |
|-------|-------|-------|-------|---|---|----|---|
| json | textmap2 | 37.5% | 47.5% | 34 | 54 | 4.10 | 0.0428 |

_b = A correct & B wrong; c = A wrong & B correct. p<0.05 ⇒ the arms differ significantly._
