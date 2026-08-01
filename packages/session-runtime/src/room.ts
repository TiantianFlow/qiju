import {
  hashState,
  observePublic,
  observeSeat,
  transition,
  type CompiledRuleRuntime,
  type DomainEvent,
  type GameCommand,
  type MatchState,
  type PublicView,
  type SeatId,
  type SeatObservation,
} from "@qiju/game-core";
import type { Agent } from "@qiju/agents";
import { deterministicFallback } from "@qiju/agents";
import type { Clock, ClockTimerHandle } from "./clock.js";

export type ControllerKind = "human" | "agent" | "observer";

export interface SeatController {
  seatId: SeatId;
  kind: ControllerKind;
  principalId?: string;
  agent?: Agent;
}

export interface SessionPolicy {
  humanActionWindowMs: number;
  agentDecisionBudgetMs: number;
  demoStepDelayMs: number;
}

export const DEFAULT_SESSION_POLICY: SessionPolicy = {
  humanActionWindowMs: 30000,
  agentDecisionBudgetMs: 500,
  demoStepDelayMs: 1200,
};

export type RejectionCode =
  | "MATCH_NOT_FOUND_OR_FORBIDDEN"
  | "MATCH_NOT_ACTIVE"
  | "COMMAND_SCHEMA_INVALID"
  | "COMMAND_ID_REUSE_MISMATCH"
  | "STALE_REVISION"
  | "ACTION_WINDOW_MISMATCH"
  | "ACTION_WINDOW_CLOSED"
  | "ACTION_ALREADY_LOCKED"
  | "ACTION_ILLEGAL"
  | "AUTH_REQUIRED";

export interface ProcessedOutcome {
  commandId: string;
  commandHash: string;
  accepted: boolean;
  revision: number;
  rejectionCode?: RejectionCode;
}

export interface CommandResult {
  accepted: boolean;
  revision: number;
  rejectionCode?: RejectionCode;
  duplicate?: boolean;
}

export interface RoomSnapshot {
  matchId: string;
  revision: number;
  stateHash: string;
  phase: string;
  round: number;
}

export type ViewUpdate =
  | { kind: "public"; view: PublicView }
  | { kind: "seat"; seatId: SeatId; view: SeatObservation };

export interface RoomEvents {
  onViewUpdate(update: ViewUpdate, revision: number): void;
  onMatchCompleted(result: unknown, finalStateHash: string): void;
  onEvents(events: DomainEvent[]): void;
  onAgentDiagnostics?(seatId: SeatId, diagnostics: Record<string, unknown>): void;
}

export interface RoomConfig {
  matchId: string;
  seed: string;
  runtime: CompiledRuleRuntime;
  seats: SeatController[];
  policy: SessionPolicy;
  clock: Clock;
  events: RoomEvents;
  mode: "human-vs-ai" | "all-ai";
}

interface PendingDeadline {
  actionWindowId: string;
  handle: ClockTimerHandle | null;
  deadlineAtMs: number;
  remainingMs: number;
  suspended: boolean;
}

type DemoSchedulerState = "running" | "paused" | "stepping";

export class RoomExecutor {
  private state: MatchState;
  private readonly config: RoomConfig;
  private processed = new Map<string, ProcessedOutcome>();
  private deadline?: PendingDeadline | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private agentInFlight = new Set<string>();
  private readonly allEvents: DomainEvent[] = [];
  private demoScheduler: DemoSchedulerState = "running";
  private demoSpeed = 1;
  private pumpTimer: ClockTimerHandle | null = null;

  constructor(config: RoomConfig) {
    this.config = config;
    this.state = {
      matchId: config.matchId,
      revision: 0,
      seed: config.seed,
      ruleManifest: config.runtime.manifest,
      ruleManifestHash: config.runtime.manifestHash,
      contentHash: config.runtime.contentHash,
      phase: { kind: "setup" },
      seats: [
        { seatId: "seat1", setupLocked: false, toolCharges: {} },
        { seatId: "seat2", setupLocked: false, toolCharges: {} },
        { seatId: "seat3", setupLocked: false, toolCharges: {} },
        { seatId: "seat4", setupLocked: false, toolCharges: {} },
      ],
      round: 0,
      loadoutsRevealed: false,
      intel: [],
      reveals: [],
      streams: {},
      toolUseOrdinal: {},
    };
  }

  get matchId(): string {
    return this.config.matchId;
  }

  get revision(): number {
    return this.state.revision;
  }

  get isCompleted(): boolean {
    return this.state.phase.kind === "completed";
  }

  get phaseKind(): string {
    return this.state.phase.kind;
  }

  get mode(): "human-vs-ai" | "all-ai" {
    return this.config.mode;
  }

  get demoState(): { paused: boolean; speed: number } {
    return { paused: this.demoScheduler !== "running", speed: this.demoSpeed };
  }

  get acceptedEvents(): readonly DomainEvent[] {
    return this.allEvents;
  }

  get currentState(): MatchState {
    return this.state;
  }

  snapshot(): RoomSnapshot {
    return {
      matchId: this.config.matchId,
      revision: this.state.revision,
      stateHash: hashState(this.state),
      phase: this.state.phase.kind,
      round: this.state.round,
    };
  }

  seatIdForPrincipal(principalId: string): SeatId | null {
    const seat = this.config.seats.find((s) => s.principalId === principalId);
    return seat ? seat.seatId : null;
  }

  isObserverPrincipal(): boolean {
    return this.config.mode === "all-ai";
  }

  viewForPrincipal(principalId: string): PublicView | SeatObservation | null {
    if (this.config.mode === "all-ai") {
      return observePublic(this.config.runtime, this.state);
    }
    const seatId = this.seatIdForPrincipal(principalId);
    if (!seatId) return null;
    return observeSeat(this.config.runtime, this.state, seatId);
  }

  publicView(): PublicView {
    return observePublic(this.config.runtime, this.state);
  }

  setDemoPaused(paused: boolean): void {
    if (this.config.mode !== "all-ai") return;
    if (paused) {
      if (this.demoScheduler === "paused") return;
      this.demoScheduler = "paused";
      this.cancelPump();
      this.suspendDeadline();
      return;
    }
    if (this.demoScheduler === "running") return;
    this.demoScheduler = "running";
    this.resumeDeadline();
    this.enqueue(() => {
      this.scheduleNextPump(0);
      return undefined;
    });
  }

  setDemoSpeed(speed: number): void {
    this.demoSpeed = Math.max(1, Math.min(8, speed));
  }

  async demoStep(): Promise<{ changed: boolean; revision: number }> {
    if (this.config.mode !== "all-ai") {
      return { changed: false, revision: this.state.revision };
    }
    return this.enqueue(async () => {
      if (this.isCompleted) return { changed: false, revision: this.state.revision };
      const revisionBefore = this.state.revision;
      const eventsBefore = this.allEvents.length;
      this.demoScheduler = "stepping";
      try {
        await this.performOneSessionAction();
      } finally {
        this.demoScheduler = "paused";
      }
      this.cancelPump();
      this.suspendDeadline();
      const changed = this.state.revision !== revisionBefore || this.allEvents.length !== eventsBefore;
      return { changed, revision: this.state.revision };
    });
  }

  private cancelPump(): void {
    this.pumpTimer?.cancel();
    this.pumpTimer = null;
  }

  private scheduleNextPump(delayMs: number): void {
    if (this.config.mode !== "all-ai") return;
    if (this.demoScheduler !== "running") return;
    this.cancelPump();
    if (this.isCompleted) return;
    const clamped = Math.max(0, delayMs);
    this.pumpTimer = this.config.clock.setTimeout(() => {
      this.pumpTimer = null;
      void this.enqueue(async () => {
        await this.pumpOnce();
      });
    }, clamped);
  }

  private get remainingWork(): boolean {
    if (this.isCompleted) return false;
    for (const seat of this.config.seats) {
      if (seat.kind !== "agent" || !seat.agent) continue;
      if (this.state.phase.kind === "setup") {
        const seatState = this.state.seats.find((s) => s.seatId === seat.seatId)!;
        if (!seatState.setupLocked) return true;
        continue;
      }
      const window = this.state.window;
      if (!window) continue;
      if (!window.participants.includes(seat.seatId)) continue;
      if (window.bids[seat.seatId]?.locked !== true) return true;
    }
    return false;
  }

  private async pumpOnce(): Promise<void> {
    if (this.demoScheduler !== "running" || this.isCompleted) return;
    const progressed = await this.performOneSessionAction();
    if (this.demoScheduler !== "running" || this.isCompleted) return;
    const base = this.config.policy.demoStepDelayMs;
    const delay = progressed ? Math.max(50, Math.floor(base / this.demoSpeed)) : 0;
    this.scheduleNextPump(delay);
  }

  private async performOneSessionAction(): Promise<boolean> {
    if (this.isCompleted) return false;

    if (this.deadline && this.deadline.suspended) {
      if (this.state.phase.kind !== "setup" && this.state.window) {
        this.resumeDeadline();
      }
    }

    const pendingAgent = this.config.seats.find((seat) => {
      if (seat.kind !== "agent" || !seat.agent) return false;
      if (this.state.phase.kind === "setup") {
        const seatState = this.state.seats.find((s) => s.seatId === seat.seatId)!;
        return !seatState.setupLocked;
      }
      const window = this.state.window;
      if (!window) return false;
      if (!window.participants.includes(seat.seatId)) return false;
      return window.bids[seat.seatId]?.locked !== true;
    });
    if (pendingAgent) {
      await this.decideForAgent(pendingAgent);
      return true;
    }

    if (this.deadline) {
      const windowId = this.deadline.actionWindowId;
      const commandId = `deadline:${this.config.matchId}:${windowId}`;
      this.deadline.handle?.cancel();
      this.deadline = undefined;
      const result = this.submitCommandInline({
        commandId,
        expectedRevision: this.state.revision,
        seatId: null,
        command: { kind: "deadline_reached", actionWindowId: windowId },
        source: "system",
      });
      return result.accepted;
    }
    return false;
  }

  private suspendDeadline(): void {
    if (!this.deadline || this.deadline.suspended) return;
    const remaining = this.deadline.deadlineAtMs - this.config.clock.now();
    this.deadline.handle?.cancel();
    this.deadline.handle = null;
    this.deadline.suspended = true;
    this.deadline.remainingMs = Math.max(0, remaining);
  }

  private resumeDeadline(): void {
    if (!this.deadline || !this.deadline.suspended) return;
    this.deadline.suspended = false;
  }

  private enqueue<T>(task: () => Promise<T> | T): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async submitCommand(input: {
    commandId: string;
    expectedRevision: number;
    seatId: SeatId | null;
    command: GameCommand;
    source: "human" | "system";
  }): Promise<CommandResult> {
    return this.enqueue(() => this.processCommand(input));
  }

  private submitCommandInline(input: {
    commandId: string;
    expectedRevision: number;
    seatId: SeatId | null;
    command: GameCommand;
    source: "human" | "system";
  }): CommandResult {
    return this.processCommand(input);
  }

  private commandHash(command: GameCommand): string {
    return hashState({ command } as never);
  }

  private processCommand(input: {
    commandId: string;
    expectedRevision: number;
    seatId: SeatId | null;
    command: GameCommand;
    source: "human" | "system";
  }): CommandResult {
    const existing = this.processed.get(input.commandId);
    const hash = this.commandHash(input.command);
    if (existing) {
      if (existing.commandHash !== hash) {
        return {
          accepted: false,
          revision: this.state.revision,
          rejectionCode: "COMMAND_ID_REUSE_MISMATCH",
          duplicate: true,
        };
      }
      return {
        accepted: existing.accepted,
        revision: existing.revision,
        ...(existing.rejectionCode ? { rejectionCode: existing.rejectionCode } : {}),
        duplicate: true,
      };
    }

    if (input.source === "human") {
      if (!input.seatId) {
        const outcome: ProcessedOutcome = {
          commandId: input.commandId,
          commandHash: hash,
          accepted: false,
          revision: this.state.revision,
          rejectionCode: "AUTH_REQUIRED",
        };
        this.processed.set(input.commandId, outcome);
        return { accepted: false, revision: this.state.revision, rejectionCode: "AUTH_REQUIRED" };
      }
      if (input.expectedRevision !== this.state.revision) {
        const outcome: ProcessedOutcome = {
          commandId: input.commandId,
          commandHash: hash,
          accepted: false,
          revision: this.state.revision,
          rejectionCode: "STALE_REVISION",
        };
        this.processed.set(input.commandId, outcome);
        return { accepted: false, revision: this.state.revision, rejectionCode: "STALE_REVISION" };
      }
    }

    if (this.state.phase.kind === "completed") {
      const outcome: ProcessedOutcome = {
        commandId: input.commandId,
        commandHash: hash,
        accepted: false,
        revision: this.state.revision,
        rejectionCode: "MATCH_NOT_ACTIVE",
      };
      this.processed.set(input.commandId, outcome);
      return { accepted: false, revision: this.state.revision, rejectionCode: "MATCH_NOT_ACTIVE" };
    }

    const result = transition(this.config.runtime, this.state, input.command);
    if (result.kind === "rejected") {
      const outcome: ProcessedOutcome = {
        commandId: input.commandId,
        commandHash: hash,
        accepted: false,
        revision: this.state.revision,
        rejectionCode: result.code,
      };
      this.processed.set(input.commandId, outcome);
      return { accepted: false, revision: this.state.revision, rejectionCode: result.code };
    }

    this.state = result.nextState;
    this.allEvents.push(...result.events);
    const outcome: ProcessedOutcome = {
      commandId: input.commandId,
      commandHash: hash,
      accepted: true,
      revision: this.state.revision,
    };
    this.processed.set(input.commandId, outcome);
    this.config.events.onEvents(result.events);
    this.afterAccepted(result.effects);
    return { accepted: true, revision: this.state.revision };
  }

  private afterAccepted(effects: readonly { kind: string }[]): void {
    this.publishViews();
    if (this.state.phase.kind === "completed") {
      this.deadline?.handle?.cancel();
      this.deadline = undefined;
      this.cancelPump();
      const result = this.state.phase.result;
      this.config.events.onMatchCompleted(result, hashState(this.state));
      return;
    }
    for (const effect of effects) {
      if (effect.kind === "schedule_deadline") {
        const e = effect as { kind: "schedule_deadline"; actionWindowId: string; delayMs: number };
        this.scheduleDeadline(e.actionWindowId, e.delayMs);
      }
    }
    if (this.config.mode === "all-ai") {
      if (this.demoScheduler === "running" && !this.remainingWork) {
        this.scheduleNextPump(0);
      } else if (this.demoScheduler !== "running") {
        this.suspendDeadline();
      }
      return;
    }
    void this.enqueue(async () => {
      await this.driveAgents();
    });
  }

  private scheduleDeadline(actionWindowId: string, delayMs: number): void {
    this.deadline?.handle?.cancel();
    const suspended = this.config.mode === "all-ai";
    const handle = suspended
      ? null
      : this.config.clock.setTimeout(() => {
          const commandId = `deadline:${this.config.matchId}:${actionWindowId}`;
          void this.submitCommand({
            commandId,
            expectedRevision: this.state.revision,
            seatId: null,
            command: { kind: "deadline_reached", actionWindowId },
            source: "system",
          });
        }, delayMs);
    this.deadline = {
      actionWindowId,
      handle,
      deadlineAtMs: this.config.clock.now() + delayMs,
      remainingMs: delayMs,
      suspended,
    };
  }

  get activeDeadlineAtMs(): number | null {
    return this.deadline?.deadlineAtMs ?? null;
  }

  private async driveAgents(): Promise<void> {
    if (this.config.mode === "all-ai" && this.demoScheduler !== "running") return;
    for (const seat of this.config.seats) {
      if (this.state.phase.kind === "completed") return;
      if (seat.kind !== "agent" || !seat.agent) continue;
      const window = this.state.window;
      if (this.state.phase.kind === "setup") {
        const seatState = this.state.seats.find((s) => s.seatId === seat.seatId)!;
        if (seatState.setupLocked) continue;
      } else if (window) {
        if (!window.participants.includes(seat.seatId)) continue;
        if (window.bids[seat.seatId]?.locked) continue;
      } else {
        continue;
      }

      const key = `${seat.seatId}:${this.state.revision}`;
      if (this.agentInFlight.has(key)) continue;
      this.agentInFlight.add(key);
      try {
        await this.decideForAgent(seat);
      } finally {
        this.agentInFlight.delete(key);
      }
    }
  }

  private async decideForAgent(seat: SeatController): Promise<void> {
    const runtime = this.config.runtime;
    const agent = seat.agent!;
    let decision: Awaited<ReturnType<Agent["decide"]>> | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const revisionAtRequest = this.state.revision;
      const observation = observeSeat(runtime, this.state, seat.seatId);
      const { legalActions } = await import("@qiju/game-core");
      const legal = legalActions(runtime, this.state, seat.seatId);
      decision = await agent.decide({
        observation,
        legalActions: legal,
        context: {
          matchId: this.config.matchId,
          revision: revisionAtRequest,
          seatId: seat.seatId,
          ...(this.state.window ? { actionWindowId: this.state.window.actionWindowId } : {}),
          ruleBundleId: runtime.manifest.ruleBundleId,
          agentSeed: `${this.config.matchId}:${this.config.seed}`,
          softTimeBudgetMs: this.config.policy.agentDecisionBudgetMs,
        },
      });
      if (this.state.revision === revisionAtRequest) break;
      if (attempt === 1) return;
    }
    if (!decision) return;
    const revisionAtRequest = this.state.revision;
    const commandId = `agent:${this.config.matchId}:${seat.seatId}:${revisionAtRequest}:${decision.action.kind}`;
    const result = this.submitCommandInline({
      commandId,
      expectedRevision: revisionAtRequest,
      seatId: seat.seatId,
      command: decision.action,
      source: "system",
    });
    if (!result.accepted && result.rejectionCode !== "STALE_REVISION") {
      const fallback = deterministicFallback({
        observation: observeSeat(runtime, this.state, seat.seatId),
        legalActions: (await import("@qiju/game-core")).legalActions(runtime, this.state, seat.seatId),
        context: {
          matchId: this.config.matchId,
          revision: this.state.revision,
          seatId: seat.seatId,
          ...(this.state.window ? { actionWindowId: this.state.window.actionWindowId } : {}),
          ruleBundleId: runtime.manifest.ruleBundleId,
          agentSeed: `${this.config.matchId}:${this.config.seed}`,
          softTimeBudgetMs: 0,
        },
      });
      this.submitCommandInline({
        commandId: `agent-fallback:${this.config.matchId}:${seat.seatId}:${this.state.revision}:${fallback.action.kind}`,
        expectedRevision: this.state.revision,
        seatId: seat.seatId,
        command: fallback.action,
        source: "system",
      });
    }
  }

  private publishViews(): void {
    if (this.config.mode === "all-ai") {
      this.config.events.onViewUpdate({ kind: "public", view: this.publicView() }, this.state.revision);
      return;
    }
    for (const seat of this.config.seats) {
      if (seat.kind !== "human") continue;
      this.config.events.onViewUpdate(
        {
          kind: "seat",
          seatId: seat.seatId,
          view: observeSeat(this.config.runtime, this.state, seat.seatId),
        },
        this.state.revision,
      );
    }
  }

  async kick(): Promise<void> {
    await this.enqueue(async () => {
      if (this.config.mode === "all-ai") {
        if (this.demoScheduler === "running") {
          this.scheduleNextPump(0);
        }
        return;
      }
      await this.driveAgents();
    });
  }
}
