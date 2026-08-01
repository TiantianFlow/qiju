export type Money = number & { readonly __brand: "Money" };

export type SeatId = "seat1" | "seat2" | "seat3" | "seat4";
export const SEAT_IDS: readonly SeatId[] = ["seat1", "seat2", "seat3", "seat4"];

export type CategoryId =
  | "artifact"
  | "geology"
  | "mechanism"
  | "botany"
  | "ephemera"
  | "anomaly";
export const CATEGORY_IDS: readonly CategoryId[] = [
  "artifact",
  "geology",
  "mechanism",
  "botany",
  "ephemera",
  "anomaly",
];

export type TierId = "documented" | "scarce" | "exceptional" | "singular";
export const TIER_IDS: readonly TierId[] = ["documented", "scarce", "exceptional", "singular"];

export type ShapeId =
  | "single"
  | "domino_h"
  | "domino_v"
  | "line3"
  | "corner3"
  | "square4"
  | "corner4"
  | "rect6";

export type ItemId = `syn.${CategoryId}.${TierId}`;
export type SlotId = `S${string}`;
export type AnalystId =
  | "analyst.surveyor"
  | "analyst.cataloger"
  | "analyst.statistician"
  | "analyst.appraiser";
export type ToolPackageId = "kit.survey" | "kit.catalog" | "kit.appraisal";
export type ProfileId = "lean" | "standard" | "premium" | "jackpot";

export type IntelFieldKind = "tier" | "category" | "shape" | "identity" | "value";

export interface Cell {
  x: number;
  y: number;
}

export interface ShapeDef {
  id: ShapeId;
  cells: Cell[];
}

export interface ItemDef {
  id: ItemId;
  nameKey: string;
  category: CategoryId;
  tier: TierId;
  shapeId: ShapeId;
  value: number;
  footprint?: { width: number; height: number };
}

export type IntelEffectSelector =
  | { kind: "randomUnknown"; field: IntelFieldKind; count: number }
  | { kind: "randomMatchingTierCount"; distinctTiers: number }
  | { kind: "randomExistingCategoryCount" }
  | { kind: "randomExistingCategoryMeanValue" };

export interface IntelEffectDef {
  id: string;
  selector: IntelEffectSelector;
}

export interface AnalystDef {
  id: AnalystId;
  nameKey: string;
  effects: Array<{ trigger: "auction_start" | `round_${2 | 3 | 4 | 5}_start`; effect: IntelEffectDef }>;
}

export interface ToolDef {
  id: string;
  nameKey: string;
  effect: IntelEffectDef;
}

export interface ToolPackageDef {
  id: ToolPackageId;
  nameKey: string;
  tools: [ToolDef, ToolDef];
}

export interface LotPolicy {
  profiles: Array<{ id: ProfileId; drawWeight: number; tierWeights: [number, number, number, number] }>;
  themeBoostFactor: number;
  slotCount: number;
}

export interface LotPolicyV1 {
  profiles: Array<{ id: ProfileId; drawWeight: number; tierWeights: [number, number, number, number] }>;
  themeBoostFactor: number;
  countMin: number;
  countMax: number;
  board: { width: number; height: number; maxAttempts: number };
}

export interface PublicIntelPoolEntry {
  id: string;
  weight: number;
  selector: IntelEffectSelector;
}

export interface ContentSyntheticV0 {
  contentBundleId: "content.synthetic.v0";
  schemaVersion: 1;
  catalog: ItemDef[];
  shapes: ShapeDef[];
  lotPolicy: LotPolicy;
  publicIntelSchedule: IntelEffectDef[];
  analysts: AnalystDef[];
  toolPackages: ToolPackageDef[];
}

export interface ContentSyntheticV1 {
  contentBundleId: "content.synthetic.v1";
  schemaVersion: 1;
  catalog: ItemDef[];
  shapes: ShapeDef[];
  lotPolicy: LotPolicyV1;
  publicIntelPool: PublicIntelPoolEntry[];
  analysts: AnalystDef[];
  toolPackages: ToolPackageDef[];
}

export interface ContentSyntheticV2 {
  contentBundleId: "content.synthetic.v2";
  schemaVersion: 1;
  catalog: ItemDef[];
  lotPolicy: LotPolicyV1;
  publicIntelPool: PublicIntelPoolEntry[];
  analysts: AnalystDef[];
  toolPackages: ToolPackageDef[];
}

export type ContentSynthetic = ContentSyntheticV0 | ContentSyntheticV1 | ContentSyntheticV2;

export interface LotPlacement {
  slotId: SlotId;
  anchor: Cell;
  cells: Cell[];
}

export interface GeneratedLot {
  generatorId: "synthetic.v0" | "synthetic.v1" | "synthetic.v2";
  hiddenProfile: ProfileId;
  hiddenThemeCategories: [CategoryId, CategoryId];
  slots: Array<{ slotId: SlotId; itemId: ItemId }>;
  actualValue: number;
  board?: { width: number; height: number; placements: LotPlacement[] };
}
