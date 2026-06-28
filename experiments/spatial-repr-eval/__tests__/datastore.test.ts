/**
 * The datastore-first chat depends on a faithful scene→files materialization
 * and on the glob/grep primitives the agent reads through.
 */

import { describe, expect, it } from "@jest/globals";
import { DATASTORE_FILES, globMatch, grepFiles, sceneToFiles } from "../core/datastore";
import { makeSyntheticScene } from "../core/scene";

describe("sceneToFiles", () => {
  const scene = makeSyntheticScene({ id: "ds", seed: 7, blocksX: 3, blocksY: 3 });
  const files = sceneToFiles(scene);

  it("materializes every advertised file", () => {
    for (const f of DATASTORE_FILES) expect(files[f]).toBeDefined();
  });

  it("buildings.json is valid JSON and carries addresses", () => {
    const parsed = JSON.parse(files["buildings.json"]);
    expect(Array.isArray(parsed)).toBe(true);
    expect(files["buildings.json"]).toContain("H Street");
  });

  it("equipment is a GeoJSON FeatureCollection with serves", () => {
    const fc = JSON.parse(files["layers/equipment.geojson"]);
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features.some((f: { properties: { serves: string[] } }) => f.properties.serves)).toBe(
      true,
    );
  });

  it("includes the text map", () => {
    expect(files["textmap.txt"]).toContain("TEXT MAP");
  });
});

describe("glob/grep primitives", () => {
  const scene = makeSyntheticScene({ id: "ds", seed: 1, blocksX: 2, blocksY: 2 });
  const files = sceneToFiles(scene);
  const paths = Object.keys(files);

  it("globs by segment and across segments", () => {
    expect(globMatch("layers/*", paths).sort()).toEqual([
      "layers/cables.geojson",
      "layers/equipment.geojson",
    ]);
    expect(globMatch("**", paths).length).toBe(paths.length);
    expect(globMatch("*.json", paths).sort()).toEqual(["buildings.json", "streets.json"]);
  });

  it("greps contents with path:line form and can scope to one file", () => {
    const hits = grepFiles("CL-A", files);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toMatch(/^[\w./]+:\d+: /);
    const scoped = grepFiles("closure", files, "textmap.txt");
    expect(scoped.every((l) => l.startsWith("textmap.txt:"))).toBe(true);
  });
});
