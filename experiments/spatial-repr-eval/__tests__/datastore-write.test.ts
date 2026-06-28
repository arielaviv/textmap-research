/**
 * The workspace is datastore-first: edits go to the structured files and the
 * views (map, textmap) re-derive. These cover the write primitives, the
 * files→Scene roundtrip that powers re-rendering, and the Mapbox URL builder.
 */

import { describe, expect, it } from "@jest/globals";
import { applyEdit, applyWrite, filesToScene, sceneToFiles } from "../core/datastore";
import { buildMapboxStaticUrl, sceneToMapGeometry } from "../core/map-url";
import { makeSyntheticScene } from "../core/scene";

const scene = makeSyntheticScene({ id: "ws", seed: 7, blocksX: 3, blocksY: 3 });
const files = sceneToFiles(scene);

describe("write primitives", () => {
  it("applyWrite creates/overwrites a file", () => {
    const w = applyWrite(files, "notes.txt", "hello");
    expect(w.ok).toBe(true);
    expect(w.files["notes.txt"]).toBe("hello");
    expect(files["notes.txt"]).toBeUndefined(); // immutable: original untouched
  });

  it("applyEdit replaces a unique snippet", () => {
    const e = applyEdit(files, "README.md", "Project DataStore", "Edited Store");
    expect(e.ok).toBe(true);
    expect(e.files["README.md"]).toContain("Edited Store");
  });

  it("applyEdit fails on missing / ambiguous / absent file", () => {
    expect(applyEdit(files, "README.md", "NOT-THERE-XYZ", "x").ok).toBe(false);
    expect(applyEdit(files, "nope.txt", "a", "b").ok).toBe(false);
    const dup = applyWrite(files, "d.txt", "X X").files;
    expect(applyEdit(dup, "d.txt", "X", "Y").ok).toBe(false); // ambiguous
  });
});

describe("files → Scene roundtrip (powers re-render)", () => {
  const back = filesToScene(files);
  it("recovers counts and ids", () => {
    expect(back).not.toBeNull();
    expect(back?.buildings.length).toBe(scene.buildings.length);
    expect(back?.equipment.length).toBe(scene.equipment.length);
    expect(back?.cables.length).toBe(scene.cables.length);
    expect(back?.buildings[0].id).toBe(scene.buildings[0].id);
  });
  it("preserves serves + address", () => {
    const cl = back?.equipment.find((e) => e.kind === "closure");
    expect(cl?.serves.length).toBeGreaterThan(0);
    expect(back?.buildings[0].address?.street).toBe(scene.buildings[0].address?.street);
  });
  it("returns null when nothing renderable", () => {
    expect(filesToScene({ "README.md": "x" })).toBeNull();
  });
});

describe("buildMapboxStaticUrl", () => {
  it("emits a CO star pin + geojson overlay within the URL limit", () => {
    const url = buildMapboxStaticUrl(sceneToMapGeometry(scene, true), "TOKEN");
    expect(typeof url).toBe("string");
    expect(url).toContain("pin-s-star");
    expect(url).toContain("geojson(");
    expect((url ?? "").length).toBeLessThanOrEqual(8000);
  });
});
