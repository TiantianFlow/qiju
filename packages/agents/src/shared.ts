import type {
  AgentDecisionContext,
  AgentDecision,
  Agent,
} from "./contract.js";
import {
  agentRng,
  estimateLotValue,
  lockIfPossible,
} from "./contract.js";
import type { LegalActionSet, SeatObservation } from "@qiju/game-core";

export function estimateWithAggregates(observation: SeatObservation): {
  min: number;
  max: number;
  mean: number;
} {
  const base = estimateLotValue(observation);
  const knownSum = observation.slots.reduce((a, s) => {
    return a + (typeof s.knownFields.value === "number" ? s.knownFields.value : 0);
  }, 0);
  void knownSum;
  return base;
}

export interface DecisionInput {
  observation: SeatObservation;
  legalActions: LegalActionSet;
  context: AgentDecisionContext;
}

export function decideSetup(input: DecisionInput): AgentDecision | null {
  const { observation, legalActions, context } = input;
  const rng = agentRng(context);
  const selectAction = legalActions.actions.find((a) => a.kind === "select_loadout");
  if (selectAction && selectAction.kind === "select_loadout") {
    const needsAnalyst = observation.mySeat.analystId === undefined;
    const needsKit = observation.mySeat.toolPackageId === undefined;
    if (needsAnalyst || needsKit) {
      const analystId = needsAnalyst
        ? [...selectAction.analystIds].sort()[rng.nextBelow(selectAction.analystIds.length)]!
        : observation.mySeat.analystId!;
      const toolPackageId = needsKit
        ? [...selectAction.toolPackageIds].sort()[rng.nextBelow(selectAction.toolPackageIds.length)]!
        : observation.mySeat.toolPackageId!;
      return {
        action: { kind: "select_loadout", seatId: context.seatId, analystId, toolPackageId },
      };
    }
  }
  for (const action of legalActions.actions) {
    if (action.kind === "lock_setup") {
      return { action: { kind: "lock_setup", seatId: context.seatId } };
    }
  }
  return null;
}

export { agentRng, estimateLotValue, lockIfPossible };
export type { Agent };
