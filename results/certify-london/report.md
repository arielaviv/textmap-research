# Spatial-Representation Eval — Results

Config: {"source":"real","city":"london","n":60,"models":["anthropic/claude-haiku-4.5"],"arms":["json","textmap2"],"temperature":0,"repeats":1,"seed":1000,"isolate":true,"questionIds":null,"scale":null,"totalCalls":1200}

Total items: 1200 (errors: 0)


## Accuracy by arm (95% Wilson CI)

| Arm | Accuracy | 95% CI | n | avg in-tok | avg out-tok | avg latency | halluc. | missing-info |
|-----|----------|--------|---|-----------|------------|--------|---------|--------------|
| json | 42.2% | [38.3%, 46.2%] | 600 | 10359 | 40 | 1.3s | 0.0% | 0.0% |
| textmap2 | 46.7% | [42.7%, 50.7%] | 600 | 6821 | 45 | 1.2s | 2.7% | 0.0% |

## Accuracy by arm × category

| Arm | Category | Accuracy | 95% CI | n |
|-----|----------|----------|--------|---|
| json | crossing | 26.7% | [17.1%, 39.0%] | 60 |
| json | nearest | 96.7% | [88.6%, 99.1%] | 60 |
| json | containment | 33.3% | [22.7%, 45.9%] | 60 |
| json | coverage | 45.0% | [33.1%, 57.5%] | 60 |
| json | line-intersection | 3.3% | [0.9%, 11.4%] | 60 |
| json | on-street | 80.0% | [68.2%, 88.2%] | 60 |
| json | mixed | 12.2% | [8.2%, 17.8%] | 180 |
| json | path | 100.0% | [94.0%, 100.0%] | 60 |
| textmap2 | crossing | 13.3% | [6.9%, 24.2%] | 60 |
| textmap2 | nearest | 98.3% | [91.1%, 99.7%] | 60 |
| textmap2 | containment | 73.3% | [61.0%, 82.9%] | 60 |
| textmap2 | coverage | 20.0% | [11.8%, 31.8%] | 60 |
| textmap2 | line-intersection | 5.0% | [1.7%, 13.7%] | 60 |
| textmap2 | on-street | 91.7% | [81.9%, 96.4%] | 60 |
| textmap2 | mixed | 24.4% | [18.7%, 31.2%] | 180 |
| textmap2 | path | 91.7% | [81.9%, 96.4%] | 60 |

## Pairwise comparison (McNemar, paired)

| Arm A | Arm B | acc A | acc B | b | c | χ² | p |
|-------|-------|-------|-------|---|---|----|---|
| json | textmap2 | 42.2% | 46.7% | 52 | 79 | 5.16 | 0.0231 |

_b = A correct & B wrong; c = A wrong & B correct. p<0.05 ⇒ the arms differ significantly._
