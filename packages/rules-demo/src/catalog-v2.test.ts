import { describe, expect, it } from "vitest";
import { NAMED_ITEMS_V2, validateLocales } from "@qiju/content-demo";
import { compileDemoV2 } from "./index.js";

const runtime = compileDemoV2();

const COLOR_BANDS: Record<string, { min: number; max: number }> = {
  white: { min: 1_000, max: 4_000 },
  green: { min: 3_000, max: 12_000 },
  blue: { min: 10_000, max: 45_000 },
  purple: { min: 50_000, max: 250_000 },
  gold: { min: 300_000, max: 1_800_000 },
};

describe("v2 high-variance catalog", () => {
  it("has 41 unique items: 30 procedural color variants + 11 named collectibles", () => {
    expect(runtime.catalogSorted.length).toBe(41);
    const ids = new Set(runtime.catalogSorted.map((i) => i.id));
    expect(ids.size).toBe(41);
    const procedural = runtime.catalogSorted.filter((i) => i.id.startsWith("syn2."));
    const named = runtime.catalogSorted.filter((i) => i.id.startsWith("named."));
    expect(procedural.length).toBe(30);
    expect(named.length).toBe(11);
  });

  it("procedural white/green/blue/purple/gold items fall within their declared value band", () => {
    for (const item of runtime.catalogSorted) {
      if (!item.id.startsWith("syn2.")) continue;
      const band = COLOR_BANDS[item.colorTier!];
      expect(band).toBeDefined();
      expect(item.value).toBeGreaterThanOrEqual(band!.min);
      expect(item.value).toBeLessThanOrEqual(band!.max);
    }
  });

  it("mechanical tier floors stay monotonic across the widened value range", () => {
    const floorByTier = new Map<string, number>();
    for (const item of runtime.catalogSorted) {
      const cur = floorByTier.get(item.tier);
      if (cur === undefined || item.value < cur) floorByTier.set(item.tier, item.value);
    }
    expect(floorByTier.get("documented")!).toBeLessThanOrEqual(floorByTier.get("scarce")!);
    expect(floorByTier.get("scarce")!).toBeLessThanOrEqual(floorByTier.get("exceptional")!);
    expect(floorByTier.get("exceptional")!).toBeLessThanOrEqual(floorByTier.get("singular")!);
  });

  it("recreates every named collectible with its designed footprint, color and value", () => {
    expect(NAMED_ITEMS_V2.length).toBe(11);
    for (const named of NAMED_ITEMS_V2) {
      const item = runtime.catalog.get(named.id as never);
      expect(item, `missing catalog entry for ${named.id}`).toBeDefined();
      expect(item!.value).toBe(named.value);
      expect(item!.colorTier).toBe(named.colorTier);
      expect(item!.footprint).toEqual({ width: named.width, height: named.height });
      expect(item!.footprint!.width).toBeGreaterThanOrEqual(1);
      expect(item!.footprint!.width).toBeLessThanOrEqual(5);
      expect(item!.footprint!.height).toBeGreaterThanOrEqual(1);
      expect(item!.footprint!.height).toBeLessThanOrEqual(5);
    }
  });

  it("standout jackpot lots (Golden Koi Statue, Pendragon Model) sit in the red 500k-22.6M band", () => {
    const koi = runtime.catalog.get("named.golden-koi-statue" as never)!;
    const pendragon = runtime.catalog.get("named.pendragon-model" as never)!;
    expect(koi.value).toBe(22_668_888);
    expect(pendragon.value).toBe(20_171_210);
    expect(koi.value).toBeGreaterThan(500_000);
    expect(koi.value).toBeLessThanOrEqual(22_668_888);
  });

  it("small flavor items (Kokoro Rider, Broken Hilt, Tayge) draw as common documented-tier junk despite blue/green badges", () => {
    for (const id of [
      "named.kokoro-rider-l1",
      "named.kokoro-rider-l2",
      "named.kokoro-rider-l3",
      "named.broken-hilt",
      "named.tayge-air-freshener",
    ]) {
      const item = runtime.catalog.get(id as never)!;
      expect(item.tier).toBe("documented");
      expect(item.value).toBeLessThan(4_000 * 2);
    }
  });

  it("locale bundle stays fully bilingual with no empty/missing keys", () => {
    expect(validateLocales()).toEqual([]);
    for (const item of runtime.catalogSorted) {
      expect(runtime.locale["zh-CN"]?.[item.nameKey]).toBeTruthy();
      expect(runtime.locale.en?.[item.nameKey]).toBeTruthy();
    }
  });

  it("v2 lots can total into the tens of millions and stay within the widened starting budget", () => {
    expect(runtime.config.startingBudget).toBe(2_000_000);
  });
});
