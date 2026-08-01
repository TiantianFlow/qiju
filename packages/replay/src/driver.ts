import {
  createMatch,
  hashState,
  legalActions,
  observeSeat,
  transition,
  SEAT_IDS,
  type CompiledRuleRuntime,
  type DomainEvent,
  type GameCommand,
  type MatchResult,
  type SeatId,
} from "@qiju/game-core";
import type { Agent } from "@qiju/agents";

export interface SeatAssignment {
  seatId: SeatId;
  agent: Agent;
}

export interface TrajectoryEntry {
  matchId: string;
  seatId: SeatId;
  revision: number;
  actionWindowId?: string;
  observationHash: string;
  action: GameCommand;
  agentId: string;
  agentVersion: string;
  diagnostics?: Record<string, unknown>;
  result?: "accepted" | "rejected";
  rejectionCode?: string;
}

export interface MatchRunOutcome {
  matchId: string;
  seed: string;
  result: MatchResult;
  finalStateHash: string;
  events: DomainEvent[];
  trajectories: TrajectoryEntry[];
  fallbackCount: number;
  illegalAttempts: number;
}

export interface RunOptions {
  maxCommands?: number;
  collectTrajectories?: boolean;
  fallback: (input: {
    observation: ReturnType<typeof observeSeat>;
    legalActions: ReturnType<typeof legalActions>;
    seatId: SeatId;
    actionWindowId?: string;
  }) => GameCommand;
}

export async function runAgentMatch(
  runtime: CompiledRuleRuntime,
  input: {
    matchId: string;
    seed: string;
    seats: SeatAssignment[];
    agentSeedBase: string;
  },
  options: RunOptions,
): Promise<MatchRunOutcome> {
  const maxCommands = options.maxCommands ?? 400;
  let state = createMatch({ matchId: input.matchId, seed: input.seed, runtime });
  const events: DomainEvent[] = [];
  const trajectories: TrajectoryEntry[] = [];
  let fallbackCount = 0;
  let illegalAttempts = 0;

  const agentFor = (seatId: SeatId): Agent =>
    input.seats.find((s) => s.seatId === seatId)!.agent;

  let commands = 0;
  while (state.phase.kind !== "completed" && commands < maxCommands) {
    let progressed = false;
    for (const seatId of SEAT_IDS) {
      const observation = observeSeat(runtime, state, seatId);
      const legal = legalActions(runtime, state, seatId);
      const hasAction = legal.actions.some((a) => a.kind !== "wait");
      if (!hasAction) continue;

      const agent = agentFor(seatId);
      const context = {
        matchId: input.matchId,
        revision: state.revision,
        seatId,
        ...(state.window ? { actionWindowId: state.window.actionWindowId } : {}),
        ruleBundleId: runtime.manifest.ruleBundleId,
        agentSeed: `${input.agentSeedBase}:${input.seed}`,
        softTimeBudgetMs: 500,
      };
      const decision = await agent.decide({ observation, legalActions: legal, context });
      const action = decision.action;
      const validation = validateActionAgainstLegal(action, legal);
      let command = action;
      if (!validation.ok) {
        illegalAttempts++;
        command = options.fallback({
          observation,
          legalActions: legal,
          seatId,
          ...(state.window ? { actionWindowId: state.window.actionWindowId } : {}),
        });
        fallbackCount++;
      }
      const result = transition(runtime, state, command);
      if (options.collectTrajectories) {
        trajectories.push({
          matchId: input.matchId,
          seatId,
          revision: state.revision,
          ...(state.window ? { actionWindowId: state.window.actionWindowId } : {}),
          observationHash: hashState({ obs: observation } as never),
          action: command,
          agentId: agent.agentId,
          agentVersion: agent.agentVersion,
          ...(decision.diagnostics
            ? { diagnostics: decision.diagnostics as unknown as Record<string, unknown> }
            : {}),
          result: result.kind,
          ...(result.kind === "rejected" ? { rejectionCode: result.code } : {}),
        });
      }
      if (result.kind === "accepted") {
        state = result.nextState;
        events.push(...result.events);
        progressed = true;
        commands++;
        if ((state.phase as { kind: string }).kind === "completed") break;
      }
    }
    if ((state.phase as { kind: string }).kind === "completed") break;
    if (!progressed) {
      const window = state.window;
      if (window) {
        const result = transition(runtime, state, {
          kind: "deadline_reached",
          actionWindowId: window.actionWindowId,
        });
        if (result.kind === "accepted") {
          state = result.nextState;
          events.push(...result.events);
          commands++;
          continue;
        }
      }
      const pendingSeat = state.seats.find((s) => !s.setupLocked);
      if (state.phase.kind === "setup" && pendingSeat) {
        const legal = legalActions(runtime, state, pendingSeat.seatId);
        const command = options.fallback({
          observation: observeSeat(runtime, state, pendingSeat.seatId),
          legalActions: legal,
          seatId: pendingSeat.seatId,
        });
        const result = transition(runtime, state, command);
        if (result.kind === "accepted") {
          state = result.nextState;
          events.push(...result.events);
          commands++;
          continue;
        }
      }
      throw new Error(`match ${input.matchId} stuck at revision ${state.revision} phase ${state.phase.kind}`);
    }
  }

  if (state.phase.kind !== "completed") {
    throw new Error(`match ${input.matchId} did not complete within ${maxCommands} commands`);
  }

  return {
    matchId: input.matchId,
    seed: input.seed,
    result: state.phase.result,
    finalStateHash: hashState(state),
    events,
    trajectories,
    fallbackCount,
    illegalAttempts,
  };
}

function validateActionAgainstLegal(
  action: GameCommand,
  legal: ReturnType<typeof legalActions>,
): { ok: boolean } {
  for (const entry of legal.actions) {
    switch (action.kind) {
      case "select_loadout":
        if (
          entry.kind === "select_loadout" &&
          entry.analystIds.includes(action.analystId) &&
          entry.toolPackageIds.includes(action.toolPackageId)
        ) {
          return { ok: true };
        }
        break;
      case "lock_setup":
        if (entry.kind === "lock_setup") return { ok: true };
        break;
      case "use_tool":
        if (entry.kind === "use_tool" && entry.toolIds.includes(action.toolId)) return { ok: true };
        break;
      case "submit_bid":
        if (
          entry.kind === "submit_bid" &&
          Number.isSafeInteger(action.amount) &&
          action.amount >= entry.min &&
          action.amount <= entry.max &&
          action.actionWindowId === legal.actionWindowId
        ) {
          return { ok: true };
        }
        break;
      case "lock_bid":
        if (entry.kind === "lock_bid" && action.actionWindowId === legal.actionWindowId) {
          return { ok: true };
        }
        break;
      case "deadline_reached":
        return { ok: true };
    }
  }
  return { ok: false };
}
