import type { CompiledRuleRuntime } from "@qiju/game-core";
import type { Agent } from "@qiju/agents";
import { RoomExecutor, DEFAULT_SESSION_POLICY, type RoomEvents, type SeatController } from "./room.js";
import type { Clock, ClockTimerHandle } from "./clock.js";
import type { SessionPolicy } from "./room.js";

export interface RoomEvictionPolicy {
  /** How long a completed match stays reachable before it's freed. Default 5 minutes. */
  completedGraceMs?: number;
  /** How long an untouched, not-yet-completed match stays reachable. Default 30 minutes. */
  idleTimeoutMs?: number;
  /** Hard ceiling on concurrent rooms; least-recently-touched are evicted first. Default 500. */
  maxRooms?: number;
  /** How often the periodic sweep runs. Default 60 seconds. */
  sweepIntervalMs?: number;
}

export interface RoomManagerConfig {
  runtime: CompiledRuleRuntime;
  clock: Clock;
  policy?: SessionPolicy;
  agentPool: {
    humanVsAiAgents(humanSeatIndex: number): Agent[];
    allAiAgents(): Agent[];
  };
  eviction?: RoomEvictionPolicy;
  /** Called whenever a room is evicted, so callers can clean up anything keyed on matchId (e.g. open sockets). */
  onEvict?: (matchId: string) => void;
}

interface RoomEntry {
  room: RoomExecutor;
  lastTouchedAtMs: number;
  /** Set the first time the sweep observes the room as completed; null while still in progress. */
  completedAtMs: number | null;
}

/**
 * THE-24: rooms are held in memory for the life of the process with no
 * automatic eviction — every match created (one per demo/game, including
 * every random-UUID match nobody ever revisits) accumulates forever. This
 * bounds that in three ways: a short grace period after completion, an
 * idle timeout for matches nobody has touched, and a hard cap (checked both
 * on creation and periodically) that evicts the least-recently-touched room
 * regardless of the time-based rules, so memory use can never grow past a
 * known ceiling no matter what leaks past the other two.
 *
 * "Touched" is deliberately generous: get() (every view fetch, every stream
 * connect) and the explicit touch() app.ts calls on each WS message both
 * refresh it, and the idle timeout (30 min default) is far longer than any
 * realistic silent stretch in normal play (max ~10 min of human bidding
 * windows across a full match) — so a genuinely active session, even a
 * quiet one, is never at risk of the idle sweep.
 */
export class RoomManager {
  private rooms = new Map<string, RoomEntry>();
  private readonly config: RoomManagerConfig;
  private readonly eviction: Required<RoomEvictionPolicy>;
  private sweepTimer: ClockTimerHandle | null = null;

  constructor(config: RoomManagerConfig) {
    this.config = config;
    this.eviction = {
      completedGraceMs: config.eviction?.completedGraceMs ?? 5 * 60_000,
      idleTimeoutMs: config.eviction?.idleTimeoutMs ?? 30 * 60_000,
      maxRooms: config.eviction?.maxRooms ?? 500,
      sweepIntervalMs: config.eviction?.sweepIntervalMs ?? 60_000,
    };
    this.scheduleSweep();
  }

  get(matchId: string): RoomExecutor | undefined {
    const entry = this.rooms.get(matchId);
    if (!entry) return undefined;
    entry.lastTouchedAtMs = this.config.clock.now();
    return entry.room;
  }

  /** Explicit activity signal for callers that hold onto a RoomExecutor reference across multiple interactions (e.g. a long-lived WS connection) rather than re-fetching it via get() each time. */
  touch(matchId: string): void {
    const entry = this.rooms.get(matchId);
    if (entry) entry.lastTouchedAtMs = this.config.clock.now();
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
    if (existing) {
      existing.lastTouchedAtMs = this.config.clock.now();
      return existing.room;
    }
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
    this.rooms.set(input.matchId, {
      room,
      lastTouchedAtMs: this.config.clock.now(),
      completedAtMs: null,
    });
    if (!options?.deferKick) {
      if (mode === "all-ai") {
        void room.initializeDemoToAuctionReady();
      } else {
        void room.kick();
      }
    } else if (mode !== "all-ai") {
      void room.kick();
    }
    // Enforce the hard cap immediately too, not just on the next periodic
    // sweep - a burst of creations within one sweep interval must not be
    // able to push the room count past the ceiling even transiently.
    this.enforceHardCap();
    return room;
  }

  list(): Array<{ matchId: string; revision: number; phase: string }> {
    return [...this.rooms.values()].map((entry) => ({
      matchId: entry.room.matchId,
      revision: entry.room.revision,
      phase: entry.room.phaseKind,
    }));
  }

  private evict(matchId: string): void {
    this.rooms.delete(matchId);
    this.config.onEvict?.(matchId);
  }

  private scheduleSweep(): void {
    this.sweepTimer = this.config.clock.setTimeout(() => {
      this.sweep();
      this.scheduleSweep();
    }, this.eviction.sweepIntervalMs);
  }

  private sweep(): void {
    const now = this.config.clock.now();
    for (const [matchId, entry] of this.rooms) {
      if (entry.room.isCompleted) {
        if (entry.completedAtMs === null) entry.completedAtMs = now;
        if (now - entry.completedAtMs >= this.eviction.completedGraceMs) {
          this.evict(matchId);
        }
      } else if (now - entry.lastTouchedAtMs >= this.eviction.idleTimeoutMs) {
        this.evict(matchId);
      }
    }
    this.enforceHardCap();
  }

  private enforceHardCap(): void {
    const excess = this.rooms.size - this.eviction.maxRooms;
    if (excess <= 0) return;
    const oldest = [...this.rooms.entries()]
      .sort((a, b) => a[1].lastTouchedAtMs - b[1].lastTouchedAtMs)
      .slice(0, excess);
    for (const [matchId] of oldest) this.evict(matchId);
  }
}

export * from "./clock.js";
export * from "./room.js";
