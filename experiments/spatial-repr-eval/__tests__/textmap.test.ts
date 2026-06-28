/**
 * Invariants for the LLM-optimized `textmap` representation. The whole point of
 * this arm is that the grid, the legend, and the answer space share ONE id
 * namespace and that columns are exactly countable — so we assert exactly that.
 */

import { describe, expect, it } from "@jest/globals";
import { makeSyntheticScene } from "../core/scene";
import { toTextMap } from "../core/textmap";

function gridRows(out: string): string[] {
  // Data rows look like "00 |....#....|" — between the +---+ borders.
  return out.split("\n").filter((l) => /^\d\d \|.*\|$/.test(l));
}

describe("textmap", () => {
  const scene = makeSyntheticScene({ id: "tm", seed: 7, blocksX: 3, blocksY: 3 });
  const out = toTextMap(scene);

  it("lists every scene id verbatim in the legend (namespace match)", () => {
    for (const e of scene.equipment) expect(out).toContain(e.id);
    for (const b of scene.buildings) expect(out).toContain(b.id);
  });

  it("shows synthesized addresses in the legend", () => {
    // makeSyntheticScene assigns even numbers down "H Street {row}".
    const b = scene.buildings[0];
    expect(b.address).toBeDefined();
    expect(out).toContain(`addr "${b.address?.number} ${b.address?.street}"`);
  });

  it("uses single-code-point cells so every grid row has equal width", () => {
    const rows = gridRows(out);
    expect(rows.length).toBeGreaterThan(0);
    const widths = new Set(rows.map((r) => [...r].length));
    expect(widths.size).toBe(1);
  });

  it("places the CO marker '*' on the grid and labels it in the legend", () => {
    const co = scene.equipment.find((e) => e.kind === "co");
    expect(co).toBeDefined();
    expect(gridRows(out).some((r) => r.includes("*"))).toBe(true);
    expect(out).toMatch(new RegExp(`${co?.id}\\s+\\*`));
  });

  it("marks each closure with a lowercase letter shared between grid and legend", () => {
    const closures = scene.equipment.filter((e) => e.kind === "closure");
    // First closure → 'a' (assigned in scene-equipment order, CO is '*').
    expect(out).toMatch(new RegExp(`${closures[0].id}\\s+a\\b`));
    expect(gridRows(out).some((r) => /a/.test(r))).toBe(true);
  });
});

describe("synthetic scene addresses", () => {
  it("populates an address on every building", () => {
    const scene = makeSyntheticScene({ id: "addr", seed: 3, blocksX: 2, blocksY: 2 });
    for (const b of scene.buildings) {
      expect(b.address?.number).toMatch(/^\d+$/);
      expect(b.address?.street).toContain("Street");
    }
  });
});
