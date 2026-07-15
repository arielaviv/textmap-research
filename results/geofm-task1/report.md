# GeoFM Task-1 external validation — anthropic/claude-haiku-4.5

Items: their 1400-triplet test split, zero-shot, their prompt + grading (full-triple match).
Their baselines (recomputed from their per-item outputs): GPT-4 zero-shot 0.628, GPT-4 few-shot 0.661, GPT-3.5 zero-shot 0.369.

## wkt: 58.9% (825/1400, errors 0, cost $0.56)

| predicate | acc | n |
|---|---|---|
| contains | 59% | 200 |
| crosses | 25% | 120 |
| disjoint | 76% | 360 |
| equals | 81% | 120 |
| overlaps | 65% | 80 |
| touches | 42% | 320 |
| within | 61% | 200 |

## textmap: 56.6% (793/1400, errors 0, cost $7.03)

| predicate | acc | n |
|---|---|---|
| contains | 18% | 200 |
| crosses | 22% | 120 |
| disjoint | 97% | 360 |
| equals | 92% | 120 |
| overlaps | 58% | 80 |
| touches | 34% | 320 |
| within | 59% | 200 |

Wall clock: 10.7 min
