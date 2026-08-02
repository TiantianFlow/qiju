import type { CompiledRuleRuntime } from "@qiju/game-core";
import type { Agent } from "@qiju/agents";
import { RoomExecutor, DEFAULT_SESSION_POLICY, type RoomEvents, type SeatController } from "./room.js";
import type { Clock } from "./clock.js";
import type { SessionPolicy } from "./room.js";

export interface RoomManagerConfig {
  runtime: CompiledRuleRuntime;
  clock: Clock;
  policy?: SessionPolicy;
  agentPool: {
    humanVsAiAgents(humanSeatIndex: number): Agent[];
    allAiAgents(): Agent[];
  };
}

export class RoomManager {
  private rooms = new Map<string, RoomExecutor>();
  private readonly config: RoomManagerConfig;

  constructor(config: RoomManagerConfig) {
    this.config = config;
  }

  get(matchId: string): RoomExecutor | undefined {
    return this.rooms.get(matchId);
  }

  delete(matchId: string): void {
    this.rooms.delete(matchId);
  }

  createHumanVsAi(input: {
    matchId: string;
    seed: string;
    humanPrincipalId: string;
    events: RoomEvents;
  }): RoomExecutor {
    const agents = this.config.agentPool.humanVsAiAgents(0);
    const seats: SeatController[] = [
      { seatId: "seat1", kind: "human", principalId: input.humanPrincipalId },
      { seatId: "seat2", kind: "agent", agent: agents[1]! },
      { seatId: "seat3", kind: "agent", agent: agents[2]! },
      { seatId: "seat4", kind: "agent", agent: agents[3]! },
    ];
    return this.create(input, seats, "human-vs-ai");
  }

  createAllAi(input: { matchId: string; seed: string; events: RoomEvents; startPaused?: boolean }): RoomExecutor {
    const agents = this.config.agentPool.allAiAgents();
    const seats: SeatController[] = agents.map((agent, i) => ({
      seatId: `seat${i + 1}` as SeatController["seatId"],
      kind: "agent",
      agent,
    }));
    const room = this.create(input, seats, "all-ai", { deferKick: true });
    room.setDemoPaused(true);
    void (async () => {
      await room.initializeDemoToAuctionReady();
      if (input.startPaused === false) {
        room.setDemoPaused(false);
      }
    })();
    return room;
  }

  private create(
    input: { matchId: string; seed: string; events: RoomEvents },
    seats: SeatController[],
    mode: "human-vs-ai" | "all-ai",
    options?: { deferKick?: boolean },
  ): RoomExecutor {
    const existing = this.rooms.get(input.matchId);
    if (existing) return existing;
    const room = new RoomExecutor({
      matchId: input.matchId,
      seed: input.seed,
      runtime: this.config.runtime,
      seats,
      policy: this.config.policy ?? DEFAULT_SESSION_POLICY,
      clock: this.config.clock,
      events: input.events,
      mode,
    });
    this.rooms.set(input.matchId, room);
    if (!options?.deferKick) {
      if (mode === "all-ai") {
        void room.initializeDemoToAuctionReady();
      } else {
        void room.kick();
      }
    } else if (mode !== "all-ai") {
      void room.kick();
    }
    return room;
  }

  list(): Array<{ matchId: string; revision: number; phase: string }> {
    return [...this.rooms.values()].map((r) => ({
      matchId: r.matchId,
      revision: r.revision,
      phase: r.phaseKind,
    }));
  }
}

export * from "./clock.js";
export * from "./room.js";
