import type {
  GameCommand,
  LegalActionSet,
  SeatId,
  SeatObservation,
} from "@qiju/game-core";
import { Xoshiro128StarStar, deriveStreamSeed } from "@qiju/game-core";

export interface AgentDecisionContext {
  matchId: string;
  revision: number;
  seatId: SeatId;
  actionWindowId?: string | undefined;
  ruleBundleId: string;
  agentSeed: string;
  softTimeBudgetMs: number;
}

export interface AgentDiagnostics {
  estimatedValueRange?: { min: number; max: number; mean: number };
  confidence?: number;
  riskBand?: "low" | "medium" | "high";
  rationaleCodes?: string[];
}

export interface AgentDecision {
  action: GameCommand;
  diagnostics?: AgentDiagnostics;
}

export interface Agent {
  readonly agentId: string;
  readonly agentVersion: string;
  decide(input: {
    observation: SeatObservation;
    legalActions: LegalActionSet;
    context: AgentDecisionContext;
  }): Promise<AgentDecision>;
}

export function agentRng(context: AgentDecisionContext): Xoshiro128StarStar {
  return new Xoshiro128StarStar(
    deriveStreamSeed([context.agentSeed, context.matchId, `agent/${context.seatId}`]),
  );
}

export function deterministicFallback(input: {
  observation: SeatObservation;
  legalActions: LegalActionSet;
  context: AgentDecisionContext;
}): AgentDecision {
  const { observation, legalActions, context } = input;
  const hasLoadout =
    observation.mySeat.analystId !== undefined && observation.mySeat.toolPackageId !== undefined;
  if (!hasLoadout) {
    for (const action of legalActions.actions) {
      if (action.kind === "select_loadout") {
        return {
          action: {
            kind: "select_loadout",
            seatId: context.seatId,
            analystId: observation.mySeat.analystId ?? [...action.analystIds].sort()[0]!,
            toolPackageId: observation.mySeat.toolPackageId ?? [...action.toolPackageIds].sort()[0]!,
          },
        };
      }
    }
  }
  for (const action of legalActions.actions) {
    if (action.kind === "lock_setup") {
      return { action: { kind: "lock_setup", seatId: context.seatId } };
    }
  }
  if (context.actionWindowId) {
    for (const action of legalActions.actions) {
      if (action.kind === "submit_bid") {
        return {
          action: {
            kind: "submit_bid",
            seatId: context.seatId,
            amount: 0,
            actionWindowId: context.actionWindowId,
          },
        };
      }
    }
  }
  return {
    action: {
      kind: "submit_bid",
      seatId: context.seatId,
      amount: 0,
      actionWindowId: context.actionWindowId ?? "none",
    },
  };
}

export function lockIfPossible(input: {
  legalActions: LegalActionSet;
  context: AgentDecisionContext;
}): GameCommand | null {
  const { legalActions, context } = input;
  if (!context.actionWindowId) return null;
  for (const action of legalActions.actions) {
    if (action.kind === "lock_bid") {
      return { kind: "lock_bid", seatId: context.seatId, actionWindowId: context.actionWindowId };
    }
  }
  return null;
}

export function estimateLotValue(observation: SeatObservation): {
  min: number;
  max: number;
  mean: number;
} {
  let min = 0;
  let max = 0;
  let mean = 0;
  for (const slot of observation.slots) {
    const c = slot.candidates;
    min += c.minValue;
    max += c.maxValue;
    mean += c.unweightedMeanValueFloor;
  }
  return { min, max, mean };
}

export function aggregateAdjustments(observation: SeatObservation): {
  tierCounts: Map<string, number>;
  categoryCounts: Map<string, number>;
  categoryMeans: Map<string, number>;
} {
  const tierCounts = new Map<string, number>();
  const categoryCounts = new Map<string, number>();
  const categoryMeans = new Map<string, number>();
  const all = [...observation.publicIntel, ...observation.mySeat.privateIntel];
  for (const record of all) {
    if (record.fact.kind !== "aggregate") continue;
    if (record.fact.metric === "count" && record.fact.dimension === "tier") {
      tierCounts.set(record.fact.key, record.fact.value);
    }
    if (record.fact.metric === "count" && record.fact.dimension === "category") {
      categoryCounts.set(record.fact.key, record.fact.value);
    }
    if (record.fact.metric === "meanValueFloor" && record.fact.dimension === "category") {
      categoryMeans.set(record.fact.key, record.fact.value);
    }
  }
  return { tierCounts, categoryCounts, categoryMeans };
}
