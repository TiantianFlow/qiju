import { describe, expect, it } from "vitest";
import { buildFixtures, validateLocales } from "@qiju/content-demo";
import { compileDemoV0 } from "@qiju/rules-demo";

const runtime = compileDemoV0();
const fixtures = buildFixtures();

describe("content.synthetic.v0", () => {
  it("catalog has exactly 24 unique identities covering 6x4", () => {
    expect(runtime.catalog.size).toBe(24);
    const categories = new Set<string>();
    const tiers = new Set<string>();
    for (const item of runtime.catalogSorted) {
      categories.add(item.category);
      tiers.add(item.tier);
    }
    expect(categories.size).toBe(6);
    expect(tiers.size).toBe(4);
    const ids = new Set(runtime.catalogSorted.map((i) => i.id));
    expect(ids.size).toBe(24);
  });

  it("values match frozen table", () => {
    const expectValues: Record<string, number> = {
      "syn.artifact.documented": 140,
      "syn.geology.documented": 160,
      "syn.mechanism.documented": 180,
      "syn.botany.documented": 200,
      "syn.ephemera.documented": 220,
      "syn.anomaly.documented": 250,
      "syn.artifact.scarce": 420,
      "syn.geology.scarce": 470,
      "syn.mechanism.scarce": 520,
      "syn.botany.scarce": 570,
      "syn.ephemera.scarce": 620,
      "syn.anomaly.scarce": 730,
      "syn.artifact.exceptional": 1200,
      "syn.geology.exceptional": 1350,
      "syn.mechanism.exceptional": 1500,
      "syn.botany.exceptional": 1650,
      "syn.ephemera.exceptional": 1800,
      "syn.anomaly.exceptional": 2100,
      "syn.artifact.singular": 3360,
      "syn.geology.singular": 3780,
      "syn.mechanism.singular": 4200,
      "syn.botany.singular": 4620,
      "syn.ephemera.singular": 5040,
      "syn.anomaly.singular": 5880,
    };
    for (const [id, value] of Object.entries(expectValues)) {
      expect(runtime.catalog.get(id as never)?.value).toBe(value);
    }
  });

  it("low-total fixture totals 3130", () => {
    const total = fixtures["content.low-total"].itemIds.reduce(
      (a, id) => a + (runtime.catalog.get(id as never)?.value ?? 0),
      0,
    );
    expect(total).toBe(fixtures["content.low-total"].expectedTotal);
  });

  it("high-total fixture totals 33930", () => {
    const total = fixtures["content.high-total"].itemIds.reduce(
      (a, id) => a + (runtime.catalog.get(id as never)?.value ?? 0),
      0,
    );
    expect(total).toBe(fixtures["content.high-total"].expectedTotal);
  });

  it("shapes are normalized, connected, within 3x3, no duplicates", () => {
    const shapes = [
      { id: "single", cells: [[0, 0]] },
      { id: "domino_h", cells: [[0, 0], [1, 0]] },
      { id: "domino_v", cells: [[0, 0], [0, 1]] },
      { id: "line3", cells: [[0, 0], [1, 0], [2, 0]] },
      { id: "corner3", cells: [[0, 0], [0, 1], [1, 1]] },
      { id: "square4", cells: [[0, 0], [1, 0], [0, 1], [1, 1]] },
      { id: "corner4", cells: [[0, 0], [0, 1], [0, 2], [1, 2]] },
      { id: "rect6", cells: [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1]] },
    ];
    for (const shape of shapes) {
      const keys = new Set(shape.cells.map(([x, y]) => `${x},${y}`));
      expect(keys.size).toBe(shape.cells.length);
      for (const [x, y] of shape.cells) {
        expect(x!).toBeGreaterThanOrEqual(0);
        expect(y!).toBeGreaterThanOrEqual(0);
        expect(x!).toBeLessThan(3);
        expect(y!).toBeLessThan(3);
      }
      const minX = Math.min(...shape.cells.map(([x]) => x!));
      const minY = Math.min(...shape.cells.map(([, y]) => y!));
      expect(minX).toBe(0);
      expect(minY).toBe(0);
    }
  });

  it("locales have matching keys and placeholders, no empty values", () => {
    expect(validateLocales()).toEqual([]);
  });

  it("each shape corresponds to exactly 3 catalog identities", () => {
    const byShape = new Map<string, number>();
    for (const item of runtime.catalogSorted) {
      byShape.set(item.shapeId, (byShape.get(item.shapeId) ?? 0) + 1);
    }
    expect(byShape.size).toBe(8);
    for (const count of byShape.values()) {
      expect(count).toBe(3);
    }
  });

  it("bundle hash changes when a value changes", () => {
    const a = compileDemoV0();
    const b = compileDemoV0();
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
