# Spatial-Representation Eval — Results

Config: {"source":"real","city":"nyc","n":20,"models":["claude-haiku-4-5-20251001"],"arms":["textmap2","textmap2np"],"temperature":0,"repeats":1,"seed":1000,"isolate":true,"questionIds":null,"scale":null,"totalCalls":400}

Total items: 400 (errors: 0)


## Accuracy by arm (95% Wilson CI)

| Arm | Accuracy | 95% CI | n | avg in-tok | avg out-tok | avg latency | halluc. | missing-info |
|-----|----------|--------|---|-----------|------------|--------|---------|--------------|
| textmap2np | 45.0% | [38.3%, 51.9%] | 200 | 6439 | 48 | 1.1s | 0.5% | 0.0% |
| textmap2 | 46.5% | [39.7%, 53.4%] | 200 | 6746 | 47 | 1.2s | 0.0% | 0.0% |

## Accuracy by arm × category

| Arm | Category | Accuracy | 95% CI | n |
|-----|----------|----------|--------|---|
| textmap2np | nearest | 95.0% | [76.4%, 99.1%] | 20 |
| textmap2np | mixed | 36.7% | [25.6%, 49.3%] | 60 |
| textmap2np | line-intersection | 0.0% | [-0.0%, 16.1%] | 20 |
| textmap2np | coverage | 20.0% | [8.1%, 41.6%] | 20 |
| textmap2np | on-street | 90.0% | [69.9%, 97.2%] | 20 |
| textmap2np | crossing | 5.0% | [0.9%, 23.6%] | 20 |
| textmap2np | containment | 75.0% | [53.1%, 88.8%] | 20 |
| textmap2np | path | 55.0% | [34.2%, 74.2%] | 20 |
| textmap2 | nearest | 95.0% | [76.4%, 99.1%] | 20 |
| textmap2 | mixed | 28.3% | [18.5%, 40.8%] | 60 |
| textmap2 | line-intersection | 0.0% | [-0.0%, 16.1%] | 20 |
| textmap2 | coverage | 25.0% | [11.2%, 46.9%] | 20 |
| textmap2 | on-street | 75.0% | [53.1%, 88.8%] | 20 |
| textmap2 | crossing | 10.0% | [2.8%, 30.1%] | 20 |
| textmap2 | containment | 85.0% | [64.0%, 94.8%] | 20 |
| textmap2 | path | 90.0% | [69.9%, 97.2%] | 20 |

## Pairwise comparison (McNemar, paired)

| Arm A | Arm B | acc A | acc B | b | c | χ² | p |
|-------|-------|-------|-------|---|---|----|---|
| textmap2np | textmap2 | 45.0% | 46.5% | 13 | 16 | 0.14 | 0.7103 |

_b = A correct & B wrong; c = A wrong & B correct. p<0.05 ⇒ the arms differ significantly._
