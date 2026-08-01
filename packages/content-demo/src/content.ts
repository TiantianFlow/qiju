import type {
  AnalystDef,
  CategoryId,
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

export function buildCatalogV2(): ItemDef[] {
  const catalog: ItemDef[] = [];
  CATEGORY_ORDER.forEach((category, ci) => {
    for (const tier of TIER_ORDER) {
      catalog.push({
        id: `syn.${category}.${tier}` as ItemId,
        nameKey: `item.syn.${category}.${tier}.name`,
        category,
        tier,
        shapeId: "single",
        value: computeValue(tier, category),
        footprint: footprintForV2(tier, ci),
      });
    }
  });
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
      board: { width: 10, height: 10, maxAttempts: 64 },
    },
    publicIntelPool: buildPublicIntelPoolV1(),
    analysts: buildAnalysts(),
    toolPackages: buildToolPackages(),
  };
}
