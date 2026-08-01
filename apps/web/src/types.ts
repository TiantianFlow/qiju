export type Locale = "zh-CN" | "en";
export type Strings = Record<string, string>;

export interface SlotView {
  slotId: string;
  knownFields: Partial<{
    tier: string;
    category: string;
    shape: string;
    identity: string;
    value: number;
  }>;
  candidates: {
    candidateIds: string[];
    minValue: number;
    maxValue: number;
    unweightedMeanValueFloor: number;
  };
}

export interface IntelRecordView {
  fact:
    | { kind: "field"; slotId: string; field: string; tier?: string; category?: string; shapeId?: string; itemId?: string; value?: number }
    | { kind: "aggregate"; metric: string; dimension: string; key: string; value: number }
    | { kind: "exhausted" };
  visibility: { kind: "public" } | { kind: "seat"; seatId: string };
  sourceId: string;
  round: number;
}

export interface RevealRecord {
  round: number;
  kind: string;
  bids: Record<string, number>;
  toolUsed: Record<string, string>;
  outcome: "continue" | "sold" | "tiebreak" | "no_sale";
  buyerSeatId?: string;
  winningBid?: number;
}

export interface BoardCell {
  x: number;
  y: number;
}

export interface RevealedObject {
  revealId: string;
  anchor?: BoardCell;
  cells?: BoardCell[];
  tier?: string;
  category?: string;
  identity?: string;
  exactValue?: number;
  candidateSummary?: {
    candidateIds: string[];
    minValue: number;
    maxValue: number;
    unweightedMeanValueFloor: number;
  };
}

export interface AggregateFact {
  metric: string;
  dimension: string;
  key: string;
  value: number;
  round: number;
  visibility: string;
}

export interface LotBoard {
  schemaVersion: 1;
  width: number;
  height: number;
  concealedCells: number;
  revealedObjects: RevealedObject[];
  aggregateFacts: AggregateFact[];
}

export interface PublicEvent {
  id: string;
  revision: number;
  round: number;
  sourceKind: "auctioneer" | "analyst" | "tool" | "bidding" | "system";
  localizationKey: string;
  params: Record<string, string | number>;
  effectInstanceId?: string;
  revealIds: string[];
}

export interface MatchResultView {
  acquisition: {
    buyerSeatId?: string;
    winningBid?: number;
    settlementRound?: number;
    noSaleReason?: string;
  };
  economic: Array<{
    seatId: string;
    finalWealth: number;
    realizedProfit: number;
    bonusReward: number;
    denseEconomicRank: number;
  }>;
  training: Array<{ seatId: string; utilityNumerator: number; utilityDenominator: number }>;
}

export interface LegalActionView {
  kind: string;
  analystIds?: string[];
  toolPackageIds?: string[];
  toolIds?: string[];
  min?: number;
  max?: number;
}

export interface MatchView {
  viewer: string;
  matchId: string;
  revision: number;
  phase: "setup" | "auction" | "tiebreak" | "completed";
  round: number;
  ruleBundleId: string;
  contentBundleId: string;
  startingBudget: number;
  slots: SlotView[];
  board?: LotBoard;
  publicIntel: IntelRecordView[];
  publicEvents?: PublicEvent[];
  loadouts?: Array<{ seatId: string; analystId: string; toolPackageId: string }>;
  window?: {
    actionWindowId: string;
    kind: string;
    round: number;
    participants: string[];
    lockedSeats: string[];
    toolUsedBySeat: Record<string, string>;
  };
  reveals: RevealRecord[];
  result?: MatchResultView;
  mySeat?: {
    seatId: string;
    analystId?: string;
    toolPackageId?: string;
    setupLocked: boolean;
    toolCharges: Record<string, number>;
    currentBid?: number;
    currentBidLocked?: boolean;
    privateIntel: IntelRecordView[];
  };
  legalActions?: { seatId: string; actionWindowId?: string; actions: LegalActionView[] };
}

export interface ServerEnvelope {
  protocolVersion: number;
  serverSequence: number;
  matchId: string;
  revision: number;
  type: string;
  payload: unknown;
}

export interface SnapshotPayload {
  view: MatchView;
  deadlineAtMs: number | null;
  demo?: { paused: boolean; speed: number };
}
