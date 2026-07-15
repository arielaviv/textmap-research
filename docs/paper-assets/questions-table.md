# Question set — all 16 questions, verbatim templates

Source of truth: `experiments/spatial-repr-eval/core/questions.ts`. `{X}`
marks a scene-dependent id chosen deterministically by the engine (margin-
guarded pickers for hold-outs). Every question carries its own judgment
criterion (thresholds stated in the prompt, kept in sync with the oracle) —
a question without one tests threshold-guessing, not spatial reading.
Grading is exact: set equality for lists, ordered equality for paths/ranks,
scalar match otherwise; ties in `ho_quadrant` accept any argmax.

## Core 10 (the frozen benchmark)

| # | id | Category | Prompt (template) | Answer field | Oracle |
|---|---|---|---|---|---|
| 1 | containment | containment | List the ids of every equipment item whose point lies INSIDE a building footprint. (empty array if none) | equipmentIds | point-in-polygon per equipment |
| 2 | crossing | crossing | List the ids of every cable whose path passes THROUGH a building footprint it does not terminate at. | cableIds | segment×polygon intersection, endpoints excluded |
| 3 | onstreet | on-street | Is equipment {CL} placed on a street (within ~8m of a street centerline), as opposed to off-street / inside a building? | onStreet | point-to-polyline ≤ 8m |
| 4 | nearest | nearest | Which closure is geographically nearest to building {B}? | closureId | argmin haversine |
| 5 | coverage_gap | coverage | Is there any building with NO closure within 35m of it (a coverage gap)? List every such building. | buildingIds | per building: min distance to closures > 35m |
| 6 | topology | path | List the equipment on the path from building {B} to the source (the CO), nearest-first. | equipmentPath | serving closure (serves= contains B), then CO — ordered |
| 7 | blockage | line-intersection | If a straight cable runs from {CO} to building {B}, list every OTHER building whose footprint the straight line passes through. | buildingIds | segment×polygon over all buildings |
| 8 | road_misplacement | mixed | Some equipment may be misplaced INTO a road — within ~{IN_ROAD_M}m of a street centerline (in the carriageway). List every such item (exclude the CO). | equipmentIds | point-to-polyline ≤ IN_ROAD_M |
| 9 | enclosure | mixed | List every building in the INTERIOR of the cluster — its centroid is NOT on the outer perimeter (convex hull) of the buildings. | buildingIds | convex-hull membership |
| 10 | nearest_offstreet | mixed | Consider building {B}. Its "home street" is the street nearest to it. Which closure is nearest to {B} among closures whose OWN nearest street is a DIFFERENT street? ('none' if all sit on the home street) | closureId | nearest-street identity per closure + argmin distance |

## Hold-out 6 (written AFTER the artifact froze — generalization test; +5.2, p=0.051)

| # | id | Prompt (template) | Answer field | Oracle |
|---|---|---|---|---|
| 11 | ho_count_inside | How many equipment items have their point INSIDE a building footprint? | count | count of #1's oracle |
| 12 | ho_closer | Which building's centroid is geographically NEARER to equipment {E}: {B1} or {B2}? (pair presented in lexical order so ordering never leaks the answer; picker guarantees margin ≥ max(1.25·d, d+10m)) | buildingIds | pairwise distance compare |
| 13 | ho_bearing | Is equipment {E} NORTH or SOUTH of building {B}'s centroid? (picker maximizes Δlat) | direction | latitude sign |
| 14 | ho_midpoint | Consider the midpoint of the straight segment from {CO} to {CL}. Which building's centroid is nearest to that midpoint? (picker guarantees ≥1.15× uniqueness) | buildingIds | argmin to computed midpoint |
| 15 | ho_quadrant | Split the map into four quadrants (NE/NW/SE/SW) at the midpoint of its bounds. Which quadrant contains the MOST building centroids? | quadrant | argmax set (ties accepted) |
| 16 | ho_rank3 | List the ids of the 3 buildings whose centroids are geographically nearest to {CO}, ordered nearest first. | buildingIds | ordered top-3 by haversine |

## Category → protocol mapping (Eliav's 8-category taxonomy)

containment · crossing · on-street · nearest · coverage · path ·
line-intersection · mixed (3 questions), + `holdout` as the labeled
post-freeze generalization set.
