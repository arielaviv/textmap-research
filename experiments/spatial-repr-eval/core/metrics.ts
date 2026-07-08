/**
 * Deterministic answer-quality metrics beyond correctness.
 *
 * Hallucination = the structured answer cites an entity id that does not exist in
 * the scene. Because answers are typed id lists (forced submit_answer tool), this
 * is exact set membership — no free-text parsing, no judge model.
 *
 * Lives in its own module: questions.ts imports grade.ts, so putting this in
 * grade.ts (which would need Answer from questions.ts) would create a cycle.
 */

import type { Answer } from "./questions";
import type { Scene } from "./scene";

/** Ids cited in the answer that exist nowhere in the scene. */
export function hallucinatedIds(scene: Scene, a: Answer): string[] {
  const buildings = new Set(scene.buildings.map((b) => b.id));
  const equipment = new Set(scene.equipment.map((e) => e.id));
  const cables = new Set(scene.cables.map((c) => c.id));
  const bad = new Set<string>();
  for (const id of a.buildingIds ?? []) if (!buildings.has(id.trim())) bad.add(id);
  for (const id of a.equipmentIds ?? []) if (!equipment.has(id.trim())) bad.add(id);
  for (const id of a.cableIds ?? []) if (!cables.has(id.trim())) bad.add(id);
  for (const id of a.equipmentPath ?? []) if (!equipment.has(id.trim())) bad.add(id);
  if (a.closureId && a.closureId.trim() !== "none" && !equipment.has(a.closureId.trim())) {
    bad.add(a.closureId);
  }
  return [...bad];
}

/** True when the model reported that information was missing. */
export function askedMissingInfo(a: Answer): boolean {
  return typeof a.missingInfo === "string" && a.missingInfo.trim().length > 0;
}
