import type {
  AnalystId,
  CategoryId,
  GeneratedLot,
  IntelFieldKind,
  ItemDef,
  ItemId,
  SeatId,
  SlotId,
  TierId,
  ToolPackageId,
} from "./types.js";

export type { SeatId } from "./types.js";

export type RejectionCode =
  | "COMMAND_SCHEMA_INVALID"
  | "MATCH_NOT_ACTIVE"
  | "ACTION_ILLEGAL"
  | "ACTION_WINDOW_MISMATCH"
  | "ACTION_WINDOW_CLOSED"
  | "ACTION_ALREADY_LOCKED"
  | "STALE_REVISION";

export interface RuleBundleManifest {
  ruleBundleId: "demo.v0";
  semanticVersion: "0.1.0";
  coreProtocol: 1;
  contentBundleId: "content.synthetic.v0" | "content.synthetic.v1" | "content.synthetic.v2";
  rngAlgorithm: "rng.xoshiro128ss.v1";
}

export interface RoundMultiplier {
  numerator: number;
  denominator: number;
}

export interface RuleConfig {
  seats: 4;
  regularRounds: 5;
  maxTiebreakRounds: 1;
  startingBudget: number;
  roundMultipliers: RoundMultiplier[];
}

export interface CompiledRuleRuntime {
  manifest: RuleBundleManifest;
  manifestHash: string;
  contentHash: string;
  config: RuleConfig;
  catalog: Map<ItemId, ItemDef>;
  catalogSorted: ItemDef[];
  lotPolicy: {
    profiles: Array<{ id: string; drawWeight: number; tierWeights: readonly number[] }>;
    themeBoostFactor: number;
    slotCount?: number;
    countMin?: number;
    countMax?: number;
    board?: {
      width: number;
      height: number;
      maxAttempts: number;
      minOccupiedRows?: number;
      maxOccupiedRows?: number;
    };
  };
  publicIntelSchedule?: IntelEffectRuntime[];
  publicIntelPool?: Array<{ id: string; weight: number; selector: SelectorRuntime }>;
  analysts: Map<AnalystId, AnalystRuntime>;
  toolPackages: Map<ToolPackageId, ToolPackageRuntime>;
  locale: LocaleBundle;
}

export type SelectorRuntime =
  | { kind: "randomUnknown"; field: IntelFieldKind; count: number }
  | { kind: "randomMatchingTierCount"; distinctTiers: number }
  | { kind: "randomExistingCategoryCount" }
  | { kind: "randomExistingCategoryMeanValue" };

export interface IntelEffectRuntime {
  id: string;
  selector: SelectorRuntime;
}

export interface AnalystRuntime {
  id: AnalystId;
  nameKey: string;
  effects: Array<{ trigger: "auction_start" | `round_${number}_start`; effect: IntelEffectRuntime }>;
}

export interface ToolRuntime {
  id: string;
  nameKey: string;
  effect: IntelEffectRuntime;
}

export interface ToolPackageRuntime {
  id: ToolPackageId;
  nameKey: string;
  tools: ToolRuntime[];
}

export interface LocaleBundle {
  "zh-CN": Record<string, string>;
  en: Record<string, string>;
}

export interface RngStreamState {
  path: string;
  state: [number, number, number, number];
  draws: number;
}

export interface StreamSnapshot {
  algorithm: "rng.xoshiro128ss.v1";
  streams: RngStreamState[];
}

export type IntelFactPayload =
  | {
      kind: "field";
      slotId: SlotId;
      field: IntelFieldKind;
      tier?: TierId;
      category?: CategoryId;
      shapeId?: string;
      itemId?: ItemId;
      value?: number;
    }
  | {
      kind: "aggregate";
      metric: "count" | "meanValueFloor";
      dimension: "tier" | "category";
      key: string;
      value: number;
    }
  | { kind: "exhausted" };

export type IntelVisibility = { kind: "public" } | { kind: "seat"; seatId: SeatId };

export interface IntelRecord {
  fact: IntelFactPayload;
  visibility: IntelVisibility;
  sourceId: string;
  round: number;
  effectInstanceId: string;
  revision?: number;
}

export interface WindowBidState {
  amount: number;
  locked: boolean;
  source: "explicit" | "deadline-default";
}

export type WindowKind = "round" | "tiebreak";

export interface DecisionWindowState {
  actionWindowId: string;
  kind: WindowKind;
  round: number;
  participants: SeatId[];
  toolUsed: Record<string, string>;
  bids: Record<string, WindowBidState>;
}

export interface RoundRevealRecord {
  round: number;
  kind: WindowKind;
  bids: Record<SeatId, number>;
  toolUsed: Partial<Record<SeatId, string>>;
  outcome: "continue" | "sold" | "tiebreak" | "no_sale";
  buyerSeatId?: SeatId;
  winningBid?: number;
  revision?: number;
}

export type PublicEventSourceKind = "auctioneer" | "analyst" | "tool" | "bidding" | "system";

export interface PublicEventView {
  id: string;
  revision: number;
  round: number;
  sourceKind: PublicEventSourceKind;
  localizationKey: string;
  params: Record<string, string | number>;
  effectInstanceId?: string;
  revealIds: string[];
}

export interface AcquisitionResult {
  buyerSeatId?: SeatId;
  winningBid?: number;
  settlementRound?: number;
  noSaleReason?: "tiebreak_tie";
}

export interface EconomicResultEntry {
  seatId: SeatId;
  finalWealth: number;
  realizedProfit: number;
  bonusReward: number;
  denseEconomicRank: number;
}

export interface TrainingUtilityEntry {
  seatId: SeatId;
  utilityNumerator: number;
  utilityDenominator: number;
}

export interface MatchResult {
  acquisition: AcquisitionResult;
  economic: EconomicResultEntry[];
  training: TrainingUtilityEntry[];
}

export interface SeatState {
  seatId: SeatId;
  analystId?: AnalystId;
  toolPackageId?: ToolPackageId;
  setupLocked: boolean;
  toolCharges: Record<string, number>;
}

export type MatchPhase =
  | { kind: "setup" }
  | { kind: "auction" }
  | { kind: "tiebreak" }
  | { kind: "completed"; result: MatchResult };

export interface MatchState {
  matchId: string;
  revision: number;
  seed: string;
  ruleManifest: RuleBundleManifest;
  ruleManifestHash: string;
  contentHash: string;
  phase: MatchPhase;
  seats: SeatState[];
  lot?: GeneratedLot;
  round: number;
  loadoutsRevealed: boolean;
  intel: IntelRecord[];
  revealTokenBySlot?: Record<string, string>;
  window?: DecisionWindowState | undefined;
  reveals: RoundRevealRecord[];
  streams: Record<string, RngStreamState>;
  toolUseOrdinal: Partial<Record<SeatId, number>>;
  deadlineDelayMs?: number;
}

export type GameCommand =
  | { kind: "select_loadout"; seatId: SeatId; analystId: AnalystId; toolPackageId: ToolPackageId }
  | { kind: "lock_setup"; seatId: SeatId }
  | { kind: "use_tool"; seatId: SeatId; toolId: string; actionWindowId: string }
  | { kind: "submit_bid"; seatId: SeatId; amount: number; actionWindowId: string }
  | { kind: "lock_bid"; seatId: SeatId; actionWindowId: string }
  | { kind: "deadline_reached"; actionWindowId: string };

export type EventVisibility = "public" | SeatId | "audit";

export interface DomainEvent {
  seq: number;
  type: string;
  schemaVersion: 1;
  visibility: EventVisibility;
  payload: Record<string, unknown>;
}

export type RequestedEffect =
  | { kind: "schedule_deadline"; actionWindowId: string; delayMs: number }
  | { kind: "request_agent_decision"; seatId: SeatId; observationRevision: number }
  | { kind: "publish_views"; affectedViewers: "all" | SeatId[] }
  | { kind: "finalize_replay"; matchId: string };

export type TransitionResult =
  | { kind: "accepted"; nextState: MatchState; events: DomainEvent[]; effects: RequestedEffect[] }
  | { kind: "rejected"; code: RejectionCode; details?: Record<string, unknown> };

export type LegalAction =
  | { kind: "select_loadout"; analystIds: AnalystId[]; toolPackageIds: ToolPackageId[] }
  | { kind: "lock_setup" }
  | { kind: "use_tool"; toolIds: string[] }
  | { kind: "submit_bid"; min: number; max: number }
  | { kind: "lock_bid" }
  | { kind: "wait" };

export interface LegalActionSet {
  seatId: SeatId;
  actionWindowId?: string;
  actions: LegalAction[];
}

export interface CandidateRange {
  candidateIds: ItemId[];
  minValue: number;
  maxValue: number;
  unweightedMeanValueFloor: number;
}

export interface SlotPublicView {
  slotId: SlotId;
  knownFields: Partial<{
    tier: TierId;
    category: CategoryId;
    shape: string;
    identity: ItemId;
    value: number;
  }>;
  candidates: CandidateRange;
}

export type PublicIntelFactView =
  | {
      kind: "field";
      slotId?: SlotId;
      revealId?: string;
      field: IntelFieldKind;
      tier?: TierId;
      category?: CategoryId;
      shapeId?: string;
      itemId?: ItemId;
      value?: number;
    }
  | {
      kind: "aggregate";
      metric: "count" | "meanValueFloor";
      dimension: "tier" | "category";
      key: string;
      value: number;
    }
  | { kind: "exhausted" };

export interface PublicIntelRecordView {
  fact: PublicIntelFactView;
  visibility: IntelVisibility;
  sourceId: string;
  round: number;
  effectInstanceId: string;
  revision?: number;
}

export interface BoardCellView {
  x: number;
  y: number;
}

export interface RevealedObjectView {
  revealId: string;
  anchor?: BoardCellView;
  cells?: BoardCellView[];
  tier?: TierId;
  category?: CategoryId;
  identity?: ItemId;
  exactValue?: number;
  candidateSummary?: CandidateRange;
}

export interface AggregateFactView {
  metric: "count" | "meanValueFloor";
  dimension: "tier" | "category";
  key: string;
  value: number;
  round: number;
  visibility: "public" | SeatId;
}

export interface LotBoardView {
  schemaVersion: 1;
  width: number;
  height: number;
  concealedCells: number;
  revealedObjects: RevealedObjectView[];
  aggregateFacts: AggregateFactView[];
}

export interface PublicView {
  viewer: "public";
  matchId: string;
  revision: number;
  phase: MatchPhase["kind"];
  round: number;
  ruleBundleId: string;
  contentBundleId: string;
  startingBudget: number;
  /**
   * Expected lot value from legally visible clues only: exact values where
   * known, else each object's candidate mean. The single source of truth
   * consumed by both the player-facing HUD and the built-in agents' bidding
   * — see estimateExpectedValue in valuation.ts.
   */
  estimatedValue: number;
  slots: SlotPublicView[];
  board?: LotBoardView;
  publicIntel: PublicIntelRecordView[];
  publicEvents?: PublicEventView[];
  loadouts?: Array<{ seatId: SeatId; analystId: AnalystId; toolPackageId: ToolPackageId }>;
  window?: {
    actionWindowId: string;
    kind: WindowKind;
    round: number;
    participants: SeatId[];
    lockedSeats: SeatId[];
    toolUsedBySeat: Partial<Record<SeatId, string>>;
  };
  reveals: RoundRevealRecord[];
  result?: MatchResult;
}

export interface SeatObservation extends Omit<PublicView, "viewer"> {
  viewer: SeatId;
  mySeat: {
    seatId: SeatId;
    analystId?: AnalystId;
    toolPackageId?: ToolPackageId;
    setupLocked: boolean;
    toolCharges: Record<string, number>;
    currentBid?: number;
    currentBidLocked?: boolean;
    privateIntel: PublicIntelRecordView[];
  };
  legalActions: LegalActionSet;
}
