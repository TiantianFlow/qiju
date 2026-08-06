import {
  agentRng,
  estimateLotValue,
  lockIfPossible,
  type Agent,
  type AgentDecision,
} from "./contract.js";

export const randomLegalAgent: Agent = {
  agentId: "random-legal",
  agentVersion: "1",
  async decide(input): Promise<AgentDecision> {
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

    const windowId = context.actionWindowId;
    if (windowId && observation.mySeat.currentBid === undefined) {
      const submitAction = legalActions.actions.find((a) => a.kind === "submit_bid");
      if (submitAction && submitAction.kind === "submit_bid") {
        const amount = rng.nextBelow(submitAction.max + 1);
        return {
          action: { kind: "submit_bid", seatId: context.seatId, amount, actionWindowId: windowId },
        };
      }
    }
    if (windowId && observation.mySeat.currentBid !== undefined) {
      const toolAction = legalActions.actions.find((a) => a.kind === "use_tool");
      if (toolAction && toolAction.kind === "use_tool" && rng.nextBelow(2) === 0) {
        const toolId = [...toolAction.toolIds].sort()[rng.nextBelow(toolAction.toolIds.length)]!;
        return {
          action: { kind: "use_tool", seatId: context.seatId, toolId, actionWindowId: windowId },
        };
      }
      const lock = lockIfPossible(input);
      if (lock) return { action: lock };
    }
    return {
      action: {
        kind: "submit_bid",
        seatId: context.seatId,
        amount: 0,
        actionWindowId: windowId ?? "none",
      },
    };
  },
};

/**
 * Share of the starting budget a seat is willing to expose, indexed by round.
 * Escalates as the auction closes; the final round releases the full budget.
 */
const ROUND_EXPOSURE_PERCENT = [35, 50, 65, 80, 100] as const;

interface PersonaParams {
  winnerCurseDiscountPercent: number;
  bidFractionPercent: number;
  toolEagerness: number;
  completionBias: number;
  riskBand: "low" | "medium" | "high";
}

export function createHeuristicAgent(
  agentId: string,
  agentVersion: string,
  params: PersonaParams,
): Agent {
  return {
    agentId,
    agentVersion,
    async decide(input): Promise<AgentDecision> {
      const { observation, legalActions, context } = input;
      const rng = agentRng(context);

      for (const action of legalActions.actions) {
        if (action.kind === "select_loadout") {
          const needsAnalyst = observation.mySeat.analystId === undefined;
          const needsKit = observation.mySeat.toolPackageId === undefined;
          if (!needsAnalyst && !needsKit) continue;
          const analystId = needsAnalyst
            ? [...action.analystIds].sort()[rng.nextBelow(action.analystIds.length)]!
            : observation.mySeat.analystId!;
          const toolPackageId = needsKit
            ? [...action.toolPackageIds].sort()[rng.nextBelow(action.toolPackageIds.length)]!
            : observation.mySeat.toolPackageId!;
          return {
            action: {
              kind: "select_loadout",
              seatId: context.seatId,
              analystId,
              toolPackageId,
            },
          };
        }
      }
      for (const action of legalActions.actions) {
        if (action.kind === "lock_setup") {
          return { action: { kind: "lock_setup", seatId: context.seatId } };
        }
      }

      // Same expected-value number the player sees on the HUD (SeatObservation.estimatedValue) —
      // see estimateExpectedValue in @qiju/game-core. Range info is kept only for diagnostics.
      const baseEstimate = observation.estimatedValue;
      const range = estimateLotValue(observation);
      const windowId = context.actionWindowId;

      if (!windowId) {
        return {
          action: {
            kind: "submit_bid",
            seatId: context.seatId,
            amount: 0,
            actionWindowId: "none",
          },
        };
      }

      const toolAction = legalActions.actions.find((a) => a.kind === "use_tool");
      if (toolAction && toolAction.kind === "use_tool" && rng.nextBelow(100) < params.toolEagerness) {
        const toolId = [...toolAction.toolIds].sort()[rng.nextBelow(toolAction.toolIds.length)]!;
        return {
          action: { kind: "use_tool", seatId: context.seatId, toolId, actionWindowId: windowId },
          diagnostics: {
            estimatedValueRange: range,
            riskBand: params.riskBand,
            rationaleCodes: ["use-tool-for-info"],
          },
        };
      }

      const discounted = Math.floor(
        (baseEstimate * (100 - params.winnerCurseDiscountPercent)) / 100,
      );
      const target = Math.floor((discounted * params.bidFractionPercent) / 100);

      const round = observation.round;
      const lateRound = round >= 4 || observation.phase === "tiebreak";
      const completionBoost = lateRound ? params.completionBias : 0;
      const noise = rng.nextBelow(Math.max(1, Math.floor(target / 8) + 1));
      let amount = target + completionBoost;
      // Cap how much of the budget a seat will expose this round. Winning
      // rounds 1-4 requires beating the runner-up by a wide margin, so an
      // early all-in is pure winner's curse — yet without a cap the raw target
      // routinely exceeds the budget on a high-variance lot and clamps to the
      // full amount, which then trivially clears the 2x round-1 threshold and
      // ends the auction on the first bid. Release the whole budget only once
      // the auction is actually closing.
      const exposurePercent =
        observation.phase === "tiebreak"
          ? 100
          : (ROUND_EXPOSURE_PERCENT[Math.min(Math.max(round, 1), ROUND_EXPOSURE_PERCENT.length) - 1] ?? 100);
      const exposureCap = Math.floor((observation.startingBudget * exposurePercent) / 100);
      // Clamp to a headroom band, then add the jitter, so that seats whose raw
      // target overshoots the cap still land on *different* numbers. Clamping
      // first and jittering afterwards would push everyone back onto the cap
      // and produce ties — and a tie in the final round means nobody wins.
      amount = Math.max(0, Math.min(Math.floor((exposureCap * 7) / 8), amount)) + noise;
      amount = Math.max(0, Math.min(exposureCap, amount));

      const alreadyBid = observation.mySeat.currentBid;
      if (alreadyBid !== undefined) {
        const lock = lockIfPossible(input);
        if (lock) {
          return {
            action: lock,
            diagnostics: {
              estimatedValueRange: range,
              riskBand: params.riskBand,
              rationaleCodes: ["lock-after-bid"],
            },
          };
        }
      }

      return {
        action: {
          kind: "submit_bid",
          seatId: context.seatId,
          amount,
          actionWindowId: windowId,
        },
        diagnostics: {
          estimatedValueRange: range,
          riskBand: params.riskBand,
          rationaleCodes: ["expected-value-bid"],
        },
      };
    },
  };
}

export const cautiousAppraiserAgent = createHeuristicAgent("cautious-appraiser", "1", {
  winnerCurseDiscountPercent: 30,
  bidFractionPercent: 70,
  toolEagerness: 85,
  completionBias: 0,
  riskBand: "low",
});

export const balancedCalculatorAgent = createHeuristicAgent("balanced-calculator", "1", {
  winnerCurseDiscountPercent: 15,
  bidFractionPercent: 80,
  toolEagerness: 60,
  completionBias: 400,
  riskBand: "medium",
});

export const aggressiveChallengerAgent = createHeuristicAgent("aggressive-challenger", "1", {
  winnerCurseDiscountPercent: 8,
  bidFractionPercent: 90,
  toolEagerness: 40,
  completionBias: 1200,
  riskBand: "high",
});

export const BUILTIN_AGENTS: readonly Agent[] = [
  randomLegalAgent,
  cautiousAppraiserAgent,
  balancedCalculatorAgent,
  aggressiveChallengerAgent,
];

export function agentById(id: string): Agent | undefined {
  return BUILTIN_AGENTS.find((a) => a.agentId === id);
}
