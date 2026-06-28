/** Generates a balanced set of synthetic scene specs (mix of clean + each planted error, varied sizes). */

import type { SyntheticSpec } from "./scene";

const PLANTS: Array<SyntheticSpec["plant"]> = [
  undefined, // clean
  { closureInBuilding: true },
  { cableCrossing: true },
  { coverageGap: true },
  { closureInBuilding: true, coverageGap: true },
];

const SIZES: Array<[number, number]> = [
  [2, 2],
  [3, 2],
  [3, 3],
  [4, 3],
];

export function makeSpecs(n: number, baseSeed = 1000): SyntheticSpec[] {
  const specs: SyntheticSpec[] = [];
  for (let i = 0; i < n; i++) {
    const plant = PLANTS[i % PLANTS.length];
    const [blocksX, blocksY] = SIZES[i % SIZES.length];
    specs.push({ id: `scene-${i}`, seed: baseSeed + i * 17, blocksX, blocksY, plant });
  }
  return specs;
}
