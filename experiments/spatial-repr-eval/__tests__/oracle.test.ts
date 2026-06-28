/**
 * Oracle correctness gate. If these fail, the eval's grading is untrustworthy.
 * Each test plants a known error in grid-space and asserts the geometry oracle
 * re-derives it from coordinates alone.
 */

import { describe, expect, it } from "@jest/globals";
import {
  cablesCrossingForeignBuildings,
  closuresInsideBuildings,
  coverageGapBuildings,
  isOnStreet,
  nearestClosureToBuilding,
  pathToSource,
} from "../core/oracle";
import { makeSyntheticScene } from "../core/scene";

describe("spatial oracle", () => {
  it("clean scene has no violations", () => {
    const scene = makeSyntheticScene({ id: "clean", seed: 1, blocksX: 3, blocksY: 3 });
    expect(closuresInsideBuildings(scene)).toEqual([]);
    expect(cablesCrossingForeignBuildings(scene)).toEqual([]);
    expect(coverageGapBuildings(scene)).toEqual([]);
    // Every closure sits on a street centerline by construction.
    for (const e of scene.equipment) {
      if (e.kind === "closure") expect(isOnStreet(scene, e.id)).toBe(true);
    }
  });

  it("detects a closure planted inside a building", () => {
    const scene = makeSyntheticScene({
      id: "in-building",
      seed: 2,
      plant: { closureInBuilding: true },
    });
    const inside = closuresInsideBuildings(scene);
    expect(inside.length).toBeGreaterThan(0);
    // The planted ids must be exactly what the oracle finds.
    expect(inside.sort()).toEqual([...scene.planted.closuresInBuilding].sort());
    // A closure inside a building is not on a street.
    expect(isOnStreet(scene, scene.planted.closuresInBuilding[0])).toBe(false);
  });

  it("detects a cable crossing a foreign building", () => {
    const scene = makeSyntheticScene({
      id: "crossing",
      seed: 3,
      plant: { cableCrossing: true },
    });
    const crossing = cablesCrossingForeignBuildings(scene);
    expect(crossing).toContain("dist-cross");
  });

  it("detects a coverage gap", () => {
    const scene = makeSyntheticScene({
      id: "gap",
      seed: 4,
      plant: { coverageGap: true },
    });
    expect(coverageGapBuildings(scene).length).toBeGreaterThan(0);
  });

  it("finds the nearest closure and the path to source", () => {
    const scene = makeSyntheticScene({ id: "topology", seed: 5, blocksX: 2, blocksY: 2 });
    const b = scene.buildings[0];
    // The nearest closure to a clean building is its own serving closure.
    const serving = scene.equipment.find((e) => e.kind === "closure" && e.serves.includes(b.id));
    expect(nearestClosureToBuilding(scene, b.id)).toBe(serving?.id);
    // Path to source is [servingClosure, CO].
    const path = pathToSource(scene, b.id);
    expect(path[path.length - 1]).toBe("CO-1");
    expect(path[0]).toBe(serving?.id);
  });
});
