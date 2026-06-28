/**
 * Oracle self-test — re-verifies the grading oracle inside the Next runtime
 * (the lightweight local Node/jest paths can't resolve deps in this pnpm layout).
 *   GET /api/experiments/repr-eval/selftest
 */

import { NextResponse } from "next/server";
import {
  cablesCrossingForeignBuildings,
  closuresInsideBuildings,
  coverageGapBuildings,
  isOnStreet,
  nearestClosureToBuilding,
  pathToSource,
} from "@/experiments/spatial-repr-eval/core/oracle";
import { makeSyntheticScene } from "@/experiments/spatial-repr-eval/core/scene";

export const dynamic = "force-dynamic";

export function GET() {
  const checks: { name: string; pass: boolean }[] = [];
  const add = (name: string, pass: boolean) => checks.push({ name, pass });

  const clean = makeSyntheticScene({ id: "clean", seed: 1, blocksX: 3, blocksY: 3 });
  add("clean: no closures in buildings", closuresInsideBuildings(clean).length === 0);
  add("clean: no crossing cables", cablesCrossingForeignBuildings(clean).length === 0);
  add("clean: no coverage gap", coverageGapBuildings(clean).length === 0);
  add(
    "clean: all closures on street",
    clean.equipment.filter((e) => e.kind === "closure").every((e) => isOnStreet(clean, e.id)),
  );

  const inB = makeSyntheticScene({ id: "in", seed: 2, plant: { closureInBuilding: true } });
  add("plant: closure-in-building detected", closuresInsideBuildings(inB).length > 0);

  const cross = makeSyntheticScene({ id: "cross", seed: 3, plant: { cableCrossing: true } });
  add(
    "plant: crossing cable detected",
    cablesCrossingForeignBuildings(cross).includes("dist-cross"),
  );

  const gap = makeSyntheticScene({ id: "gap", seed: 4, plant: { coverageGap: true } });
  add("plant: coverage gap detected", coverageGapBuildings(gap).length > 0);

  const topo = makeSyntheticScene({ id: "topo", seed: 5, blocksX: 2, blocksY: 2 });
  const b0 = topo.buildings[0];
  const serving = topo.equipment.find((e) => e.kind === "closure" && e.serves.includes(b0.id));
  add(
    "topology: nearest closure is serving closure",
    nearestClosureToBuilding(topo, b0.id) === serving?.id,
  );
  add("topology: path ends at source", pathToSource(topo, b0.id).at(-1) === "CO-1");

  const failed = checks.filter((c) => !c.pass);
  return NextResponse.json({
    ok: failed.length === 0,
    passed: checks.length - failed.length,
    total: checks.length,
    checks,
  });
}
