import type {
  AnalystDef,
  CategoryId,
  ColorTierId,
  ContentSyntheticV0,
  ContentSyntheticV1,
  ContentSyntheticV2,
  IntelEffectDef,
  ItemDef,
  ItemId,
  PublicIntelPoolEntry,
  ShapeDef,
  ShapeId,
  TierId,
  ToolPackageDef,
} from "@qiju/game-core";
import { rectangularShapeId } from "@qiju/game-core";

export const CATEGORY_ORDER: readonly CategoryId[] = [
  "artifact",
  "geology",
  "mechanism",
  "botany",
  "ephemera",
  "anomaly",
];

export const TIER_ORDER: readonly TierId[] = ["documented", "scarce", "exceptional", "singular"];

const TIER_BASE: Record<TierId, number> = {
  documented: 180,
  scarce: 520,
  exceptional: 1500,
  singular: 4200,
};

const CATEGORY_PERCENT: Record<CategoryId, number> = {
  artifact: 80,
  geology: 90,
  mechanism: 100,
  botany: 110,
  ephemera: 120,
  anomaly: 140,
};

export function computeValue(tier: TierId, category: CategoryId): number {
  return 10 * Math.floor((TIER_BASE[tier]! * CATEGORY_PERCENT[category]! + 500) / 1000);
}

const SHAPE_CELLS: Record<ShapeId, Array<[number, number]>> = {
  single: [[0, 0]],
  domino_h: [
    [0, 0],
    [1, 0],
  ],
  domino_v: [
    [0, 0],
    [0, 1],
  ],
  line3: [
    [0, 0],
    [1, 0],
    [2, 0],
  ],
  corner3: [
    [0, 0],
    [0, 1],
    [1, 1],
  ],
  square4: [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ],
  corner4: [
    [0, 0],
    [0, 1],
    [0, 2],
    [1, 2],
  ],
  rect6: [
    [0, 0],
    [1, 0],
    [2, 0],
    [0, 1],
    [1, 1],
    [2, 1],
  ],
};

const SHAPE_IDS: ShapeId[] = [
  "single",
  "domino_h",
  "domino_v",
  "line3",
  "corner3",
  "square4",
  "corner4",
  "rect6",
];

export function shapeFor(tier: TierId, categoryIndex: number): ShapeId {
  const second = categoryIndex >= 3;
  switch (tier) {
    case "documented":
      return second ? "domino_h" : "single";
    case "scarce":
      return second ? "line3" : "domino_v";
    case "exceptional":
      return second ? "square4" : "corner3";
    case "singular":
      return second ? "rect6" : "corner4";
  }
}

export function buildCatalog(): ItemDef[] {
  const catalog: ItemDef[] = [];
  CATEGORY_ORDER.forEach((category, ci) => {
    for (const tier of TIER_ORDER) {
      catalog.push({
        id: `syn.${category}.${tier}` as ItemId,
        nameKey: `item.syn.${category}.${tier}.name`,
        category,
        tier,
        shapeId: shapeFor(tier, ci),
        value: computeValue(tier, category),
      });
    }
  });
  return catalog;
}

export function buildShapes(): ShapeDef[] {
  return SHAPE_IDS.map((id) => ({
    id,
    cells: SHAPE_CELLS[id]!.map(([x, y]) => ({ x, y })),
  }));
}

export function buildPublicIntelSchedule(): IntelEffectDef[] {
  return [
    { id: "intel.public.r1.shapes", selector: { kind: "randomUnknown", field: "shape", count: 2 } },
    { id: "intel.public.r2.tiers", selector: { kind: "randomUnknown", field: "tier", count: 2 } },
    { id: "intel.public.r3.category-count", selector: { kind: "randomExistingCategoryCount" } },
    { id: "intel.public.r4.identity", selector: { kind: "randomUnknown", field: "identity", count: 1 } },
    { id: "intel.public.r5.value", selector: { kind: "randomUnknown", field: "value", count: 1 } },
  ];
}

export function buildAnalysts(): AnalystDef[] {
  return [
    {
      id: "analyst.surveyor",
      nameKey: "analyst.surveyor.name",
      effects: [
        {
          trigger: "auction_start",
          effect: {
            id: "analyst.surveyor.start",
            selector: { kind: "randomUnknown", field: "shape", count: 4 },
          },
        },
      ],
    },
    {
      id: "analyst.cataloger",
      nameKey: "analyst.cataloger.name",
      effects: [
        {
          trigger: "auction_start",
          effect: {
            id: "analyst.cataloger.start",
            selector: { kind: "randomUnknown", field: "category", count: 3 },
          },
        },
        {
          trigger: "round_3_start",
          effect: {
            id: "analyst.cataloger.r3",
            selector: { kind: "randomUnknown", field: "identity", count: 1 },
          },
        },
      ],
    },
    {
      id: "analyst.statistician",
      nameKey: "analyst.statistician.name",
      effects: [
        {
          trigger: "auction_start",
          effect: {
            id: "analyst.statistician.start",
            selector: { kind: "randomMatchingTierCount", distinctTiers: 2 },
          },
        },
        {
          trigger: "round_4_start",
          effect: {
            id: "analyst.statistician.r4",
            selector: { kind: "randomExistingCategoryMeanValue" },
          },
        },
      ],
    },
    {
      id: "analyst.appraiser",
      nameKey: "analyst.appraiser.name",
      effects: [
        {
          trigger: "auction_start",
          effect: {
            id: "analyst.appraiser.start",
            selector: { kind: "randomUnknown", field: "value", count: 1 },
          },
        },
        {
          trigger: "round_2_start",
          effect: {
            id: "analyst.appraiser.r2",
            selector: { kind: "randomUnknown", field: "tier", count: 2 },
          },
        },
        {
          trigger: "round_4_start",
          effect: {
            id: "analyst.appraiser.r4",
            selector: { kind: "randomUnknown", field: "tier", count: 2 },
          },
        },
      ],
    },
  ];
}

export function buildToolPackages(): ToolPackageDef[] {
  return [
    {
      id: "kit.survey",
      nameKey: "kit.survey.name",
      tools: [
        {
          id: "kit.survey.shape-scan",
          nameKey: "kit.survey.shape-scan.name",
          effect: {
            id: "kit.survey.shape-scan",
            selector: { kind: "randomUnknown", field: "shape", count: 4 },
          },
        },
        {
          id: "kit.survey.category-scan",
          nameKey: "kit.survey.category-scan.name",
          effect: {
            id: "kit.survey.category-scan",
            selector: { kind: "randomUnknown", field: "category", count: 3 },
          },
        },
      ],
    },
    {
      id: "kit.catalog",
      nameKey: "kit.catalog.name",
      tools: [
        {
          id: "kit.catalog.tier-scan",
          nameKey: "kit.catalog.tier-scan.name",
          effect: {
            id: "kit.catalog.tier-scan",
            selector: { kind: "randomUnknown", field: "tier", count: 3 },
          },
        },
        {
          id: "kit.catalog.identify",
          nameKey: "kit.catalog.identify.name",
          effect: {
            id: "kit.catalog.identify",
            selector: { kind: "randomUnknown", field: "identity", count: 1 },
          },
        },
      ],
    },
    {
      id: "kit.appraisal",
      nameKey: "kit.appraisal.name",
      tools: [
        {
          id: "kit.appraisal.value-probe",
          nameKey: "kit.appraisal.value-probe.name",
          effect: {
            id: "kit.appraisal.value-probe",
            selector: { kind: "randomUnknown", field: "value", count: 1 },
          },
        },
        {
          id: "kit.appraisal.category-mean",
          nameKey: "kit.appraisal.category-mean.name",
          effect: {
            id: "kit.appraisal.category-mean",
            selector: { kind: "randomExistingCategoryMeanValue" },
          },
        },
      ],
    },
  ];
}

export function buildContentSyntheticV0(): ContentSyntheticV0 {
  return {
    contentBundleId: "content.synthetic.v0",
    schemaVersion: 1,
    catalog: buildCatalog(),
    shapes: buildShapes(),
    lotPolicy: {
      profiles: [
        { id: "lean", drawWeight: 20, tierWeights: [16, 6, 2, 1] },
        { id: "standard", drawWeight: 50, tierWeights: [10, 8, 4, 1] },
        { id: "premium", drawWeight: 25, tierWeights: [4, 8, 8, 3] },
        { id: "jackpot", drawWeight: 5, tierWeights: [4, 6, 8, 10] },
      ],
      themeBoostFactor: 3,
      slotCount: 10,
    },
    publicIntelSchedule: buildPublicIntelSchedule(),
    analysts: buildAnalysts(),
    toolPackages: buildToolPackages(),
  };
}

export function buildPublicIntelPoolV1(): PublicIntelPoolEntry[] {
  return [
    {
      id: "intel.public.pool.shapes-2",
      weight: 15,
      selector: { kind: "randomUnknown", field: "shape", count: 2 },
    },
    {
      id: "intel.public.pool.shapes-1",
      weight: 15,
      selector: { kind: "randomUnknown", field: "shape", count: 1 },
    },
    {
      id: "intel.public.pool.tiers-2",
      weight: 15,
      selector: { kind: "randomUnknown", field: "tier", count: 2 },
    },
    {
      id: "intel.public.pool.tiers-1",
      weight: 15,
      selector: { kind: "randomUnknown", field: "tier", count: 1 },
    },
    {
      id: "intel.public.pool.tier-count",
      weight: 10,
      selector: { kind: "randomMatchingTierCount", distinctTiers: 1 },
    },
    {
      id: "intel.public.pool.category-count",
      weight: 10,
      selector: { kind: "randomExistingCategoryCount" },
    },
    {
      id: "intel.public.pool.category-mean",
      weight: 10,
      selector: { kind: "randomExistingCategoryMeanValue" },
    },
    {
      id: "intel.public.pool.identity-1",
      weight: 10,
      selector: { kind: "randomUnknown", field: "identity", count: 1 },
    },
  ];
}

export function buildContentSyntheticV1(): ContentSyntheticV1 {
  return {
    contentBundleId: "content.synthetic.v1",
    schemaVersion: 1,
    catalog: buildCatalog(),
    shapes: buildShapes(),
    lotPolicy: {
      profiles: [
        { id: "lean", drawWeight: 20, tierWeights: [16, 6, 2, 1] },
        { id: "standard", drawWeight: 50, tierWeights: [10, 8, 4, 1] },
        { id: "premium", drawWeight: 25, tierWeights: [4, 8, 8, 3] },
        { id: "jackpot", drawWeight: 5, tierWeights: [4, 6, 8, 10] },
      ],
      themeBoostFactor: 3,
      countMin: 8,
      countMax: 12,
      board: { width: 10, height: 10, maxAttempts: 64 },
    },
    publicIntelPool: buildPublicIntelPoolV1(),
    analysts: buildAnalysts(),
    toolPackages: buildToolPackages(),
  };
}

const RECT_BY_TIER: Record<TierId, Array<[number, number]>> = {
  documented: [
    [1, 1],
    [2, 1],
  ],
  scarce: [
    [2, 1],
    [1, 2],
    [2, 2],
  ],
  exceptional: [
    [2, 2],
    [3, 1],
    [2, 3],
    [3, 2],
  ],
  singular: [
    [3, 2],
    [2, 3],
    [3, 3],
    [4, 2],
  ],
};

export function footprintForV2(tier: TierId, categoryIndex: number): { width: number; height: number } {
  const options = RECT_BY_TIER[tier];
  const [width, height] = options[categoryIndex % options.length]!;
  return { width, height };
}

/**
 * High-variance rarity color bands (Round-5). Ranges intentionally overlap
 * (e.g. gold ceiling vs red floor): color is a flavor/rarity badge, not a
 * strict value bucket — named items may deliberately sit outside their
 * band's typical range as an in-fiction bluff (see NAMED_ITEMS_V2).
 */
const COLOR_BANDS: Record<ColorTierId, { min: number; max: number }> = {
  white: { min: 1_000, max: 4_000 },
  green: { min: 3_000, max: 12_000 },
  blue: { min: 10_000, max: 45_000 },
  purple: { min: 50_000, max: 250_000 },
  gold: { min: 300_000, max: 1_800_000 },
  red: { min: 500_000, max: 22_668_888 },
};

function roundNice(value: number): number {
  if (value < 10_000) return Math.round(value / 10) * 10;
  if (value < 100_000) return Math.round(value / 100) * 100;
  if (value < 1_000_000) return Math.round(value / 1_000) * 1_000;
  return Math.round(value / 10_000) * 10_000;
}

/** Deterministic, monotonic-in-category value spread across a color band. */
function bandValue(min: number, max: number, index: number, count: number): number {
  const span = max - min;
  const raw = min + Math.floor((span * (index + 1)) / (count + 1));
  return roundNice(raw);
}

/**
 * Procedural color→mechanical-tier mapping. White+green both draw from the
 * "documented" weight bucket (common junk, thousands range); blue is
 * "scarce"; purple is "exceptional"; gold is "singular" alongside the named
 * red legendaries. This keeps the existing 4-bucket draw-weight/analyst
 * mechanics untouched while the 6-color badge rides on top as presentation.
 */
const PROCEDURAL_COLOR_TIERS: ReadonlyArray<{
  colorTier: ColorTierId;
  tier: TierId;
  footprintOffset: number;
}> = [
  { colorTier: "white", tier: "documented", footprintOffset: 0 },
  { colorTier: "green", tier: "documented", footprintOffset: 1 },
  { colorTier: "blue", tier: "scarce", footprintOffset: 0 },
  { colorTier: "purple", tier: "exceptional", footprintOffset: 0 },
  { colorTier: "gold", tier: "singular", footprintOffset: 0 },
];

export interface NamedItemDef {
  id: string;
  category: CategoryId;
  tier: TierId;
  colorTier: ColorTierId;
  width: number;
  height: number;
  value: number;
}

/**
 * Recreated famous high-variance collectibles. All footprints stay within
 * the 1-5 rectangle bound enforced by the v2 layout/test invariants. Several
 * "red" (mythic) items are deliberately valued well below red's typical band
 * floor (Unknown Access Card, White Dragon King) — the color badge signals
 * rarity/lore, not a value guarantee, which is the point of the bluff.
 */
export const NAMED_ITEMS_V2: readonly NamedItemDef[] = [
  {
    id: "named.golden-koi-statue",
    category: "artifact",
    tier: "singular",
    colorTier: "red",
    width: 4,
    height: 5,
    value: 22_668_888,
  },
  {
    id: "named.pendragon-model",
    category: "mechanism",
    tier: "singular",
    colorTier: "red",
    width: 4,
    height: 5,
    value: 20_171_210,
  },
  {
    id: "named.eternal-heart",
    category: "anomaly",
    tier: "singular",
    colorTier: "red",
    width: 1,
    height: 1,
    value: 1_314_520,
  },
  {
    id: "named.antique-suitcase",
    category: "ephemera",
    tier: "singular",
    colorTier: "red",
    width: 3,
    height: 3,
    value: 577_777,
  },
  {
    id: "named.unknown-access-card",
    category: "mechanism",
    tier: "singular",
    colorTier: "red",
    width: 1,
    height: 2,
    value: 366_112,
  },
  {
    id: "named.white-dragon-king",
    category: "artifact",
    tier: "singular",
    colorTier: "red",
    width: 3,
    height: 4,
    value: 300_000,
  },
  {
    id: "named.kokoro-rider-l1",
    category: "mechanism",
    tier: "documented",
    colorTier: "green",
    width: 1,
    height: 2,
    value: 2_400,
  },
  {
    id: "named.kokoro-rider-l2",
    category: "mechanism",
    tier: "documented",
    colorTier: "green",
    width: 2,
    height: 2,
    value: 2_800,
  },
  {
    id: "named.kokoro-rider-l3",
    category: "mechanism",
    tier: "documented",
    colorTier: "blue",
    width: 2,
    height: 2,
    value: 3_232,
  },
  {
    id: "named.broken-hilt",
    category: "artifact",
    tier: "documented",
    colorTier: "green",
    width: 1,
    height: 3,
    value: 2_139,
  },
  {
    id: "named.tayge-air-freshener",
    category: "ephemera",
    tier: "documented",
    colorTier: "blue",
    width: 1,
    height: 2,
    value: 1_795,
  },
];

/**
 * High-variance v2 catalog: 5 procedural color variants per category
 * (white/green/blue/purple/gold, 30 items) plus 11 recreated named
 * collectibles (6 red legendaries + 5 small flavor pieces) = 41 items.
 * Kept separate from `buildCatalog()` (v0/v1, frozen table + tests).
 */
export function buildCatalogV2(): ItemDef[] {
  const catalog: ItemDef[] = [];
  CATEGORY_ORDER.forEach((category, ci) => {
    for (const { colorTier, tier, footprintOffset } of PROCEDURAL_COLOR_TIERS) {
      const band = COLOR_BANDS[colorTier]!;
      const footprint = footprintForV2(tier, ci + footprintOffset);
      catalog.push({
        id: `syn2.${category}.${colorTier}` as ItemId,
        nameKey: `item.syn2.${category}.${colorTier}.name`,
        category,
        tier,
        colorTier,
        shapeId: rectangularShapeId(footprint.width, footprint.height),
        value: bandValue(band.min, band.max, ci, CATEGORY_ORDER.length),
        footprint,
      });
    }
  });
  for (const named of NAMED_ITEMS_V2) {
    catalog.push({
      id: named.id as ItemId,
      nameKey: `item.${named.id}.name`,
      category: named.category,
      tier: named.tier,
      colorTier: named.colorTier,
      shapeId: rectangularShapeId(named.width, named.height),
      value: named.value,
      footprint: { width: named.width, height: named.height },
    });
  }
  return catalog;
}

export function buildContentSyntheticV2(): ContentSyntheticV2 {
  return {
    contentBundleId: "content.synthetic.v2",
    schemaVersion: 1,
    catalog: buildCatalogV2(),
    lotPolicy: {
      profiles: [
        { id: "lean", drawWeight: 20, tierWeights: [16, 6, 2, 1] },
        { id: "standard", drawWeight: 50, tierWeights: [10, 8, 4, 1] },
        { id: "premium", drawWeight: 25, tierWeights: [4, 8, 8, 3] },
        { id: "jackpot", drawWeight: 5, tierWeights: [4, 6, 8, 10] },
      ],
      themeBoostFactor: 3,
      countMin: 8,
      countMax: 12,
      // Tall gallery board (Slice 2): generous cell budget for rare multi-legendary
      // draws (worst case ~105 cells) plus a scrollable "long showcase" viewport.
      board: { width: 10, height: 20, maxAttempts: 64 },
    },
    publicIntelPool: buildPublicIntelPoolV1(),
    analysts: buildAnalysts(),
    toolPackages: buildToolPackages(),
  };
}
