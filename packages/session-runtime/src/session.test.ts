import { describe, expect, it } from "vitest";
import { compileDemoV0 } from "@qiju/rules-demo";
import { type PublicView, type SeatObservation } from "@qiju/game-core";
import { balancedCalculatorAgent, BUILTIN_AGENTS } from "@qiju/agents";
import {
  FakeClock,
  RoomManager,
  type RoomEvents,
  type ViewUpdate,
} from "@qiju/session-runtime";

const runtime = compileDemoV0();

async function submitHuman(
  room: {
    revision: number;
    kick: () => Promise<void>;
    submitCommand: (input: never) => Promise<{ accepted: boolean; rejectionCode?: string }>;
  },
  id: string,
  command: unknown,
): Promise<{ accepted: boolean; rejectionCode?: string }> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const result = await room.submitCommand({
      commandId: `${id}-a${attempt}`,
      expectedRevision: room.revision,
      seatId: "seat1",
      command,
      source: "human",
    } as never);
    if (result.rejectionCode !== "STALE_REVISION") return result;
    await room.kick();
  }
  return { accepted: false, rejectionCode: "STALE_REVISION" };
}

function collectEvents(): { events: RoomEvents; updates: ViewUpdate[]; completed: unknown[] } {
  const updates: ViewUpdate[] = [];
  const completed: unknown[] = [];
  return {
    updates,
    completed,
    events: {
      onViewUpdate(update) {
        updates.push(update);
      },
      onMatchCompleted(result) {
        completed.push(result);
      },
      onEvents() {},
    },
  };
}

describe("session runtime (in-memory, FakeClock)", () => {
  it("runs a full human-vs-ai match: human acts, AI fills the rest", async () => {
    const clock = new FakeClock(1000);
    const manager = new RoomManager({
      runtime,
      clock,
      agentPool: {
        humanVsAiAgents: () => [
          balancedCalculatorAgent,
          BUILTIN_AGENTS[2]!,
          BUILTIN_AGENTS[2]!,
          BUILTIN_AGENTS[2]!,
        ],
        allAiAgents: () => BUILTIN_AGENTS.slice() as never,
      },
    });
    const { events, completed } = collectEvents();
    const room = manager.createHumanVsAi({
      matchId: "h-match",
      seed: "session-1",
      humanPrincipalId: "principal-1",
      events,
    });

    let r = await submitHuman(room, "cmd-select-1", {
      kind: "select_loadout",
      seatId: "seat1",
      analystId: "analyst.surveyor",
      toolPackageId: "kit.survey",
    });
    expect(r.accepted).toBe(true);
    r = await submitHuman(room, "cmd-lock-1", { kind: "lock_setup", seatId: "seat1" });
    expect(r.accepted).toBe(true);

    let guard = 0;
    while (!room.isCompleted && guard++ < 60) {
      const view = room.viewForPrincipal("principal-1") as SeatObservation;
      if (view.viewer !== "seat1") throw new Error("wrong view");
      const legal = view.legalActions;
      const window = view.window;
      if (window && !view.mySeat.currentBidLocked) {
        const bid = legal.actions.find((a) => a.kind === "submit_bid");
        if (bid && view.mySeat.currentBid === undefined) {
          const rr = await submitHuman(room, `human-bid-${room.revision}`, {
            kind: "submit_bid",
            seatId: "seat1",
            amount: 3000,
            actionWindowId: window.actionWindowId,
          });
          expect(rr.accepted).toBe(true);
        } else if (view.mySeat.currentBid !== undefined) {
          const rr = await submitHuman(room, `human-lock-${room.revision}`, {
            kind: "lock_bid",
            seatId: "seat1",
            actionWindowId: window.actionWindowId,
          });
          expect(rr.accepted).toBe(true);
        }
      }
      clock.advanceBy(31_000);
      await room.kick();
    }
    expect(room.isCompleted).toBe(true);
    expect(completed.length).toBe(1);
  });

  it("command idempotency: same commandId returns stored outcome, no double settle", async () => {
    const clock = new FakeClock(0);
    const manager = new RoomManager({
      runtime,
      clock,
      agentPool: {
        humanVsAiAgents: () => BUILTIN_AGENTS.slice(0, 4) as never,
        allAiAgents: () => BUILTIN_AGENTS.slice(0, 4) as never,
      },
    });
    const { events } = collectEvents();
    const room = manager.createHumanVsAi({
      matchId: "idem",
      seed: "idem",
      humanPrincipalId: "p1",
      events,
    });
    const cmd = {
      kind: "select_loadout" as const,
      seatId: "seat1" as const,
      analystId: "analyst.cataloger" as const,
      toolPackageId: "kit.catalog" as const,
    };
    await room.kick();
    const a = await room.submitCommand({
      commandId: "same-id",
      expectedRevision: room.revision,
      seatId: "seat1",
      command: cmd,
      source: "human",
    });
    expect(a.accepted).toBe(true);
    const b = await room.submitCommand({
      commandId: "same-id",
      expectedRevision: 0,
      seatId: "seat1",
      command: cmd,
      source: "human",
    });
    expect(a.accepted).toBe(true);
    expect(b.accepted).toBe(true);
    expect(b.duplicate).toBe(true);
    expect(b.revision).toBe(a.revision);
    const c = await room.submitCommand({
      commandId: "same-id",
      expectedRevision: 0,
      seatId: "seat1",
      command: { ...cmd, analystId: "analyst.appraiser" },
      source: "human",
    });
    expect(c.accepted).toBe(false);
    expect(c.rejectionCode).toBe("COMMAND_ID_REUSE_MISMATCH");
  });

  it("stale revision is rejected with STALE_REVISION", async () => {
    const clock = new FakeClock(0);
    const manager = new RoomManager({
      runtime,
      clock,
      agentPool: {
        humanVsAiAgents: () => BUILTIN_AGENTS.slice(0, 4) as never,
        allAiAgents: () => BUILTIN_AGENTS.slice(0, 4) as never,
      },
    });
    const { events } = collectEvents();
    const room = manager.createHumanVsAi({
      matchId: "stale",
      seed: "stale",
      humanPrincipalId: "p1",
      events,
    });
    await submitHuman(room, "x1", {
      kind: "select_loadout",
      seatId: "seat1",
      analystId: "analyst.surveyor",
      toolPackageId: "kit.survey",
    });
    const r = await room.submitCommand({
      commandId: "x2",
      expectedRevision: 0,
      seatId: "seat1",
      command: { kind: "lock_setup", seatId: "seat1" },
      source: "human",
    });
    expect(r.accepted).toBe(false);
    expect(r.rejectionCode).toBe("STALE_REVISION");
  });

  it("all-ai demo completes under FakeClock when running", async () => {
    const clock = new FakeClock(0);
    const manager = new RoomManager({
      runtime,
      clock,
      agentPool: {
        humanVsAiAgents: () => BUILTIN_AGENTS.slice(0, 4) as never,
        allAiAgents: () => BUILTIN_AGENTS.slice(0, 4) as never,
      },
    });
    const { events, completed } = collectEvents();
    const room = manager.createAllAi({ matchId: "demo", seed: "demo-1", events, startPaused: false });
    room.setDemoSpeed(4);
    let guard = 0;
    while (!room.isCompleted && guard++ < 200) {
      clock.advanceBy(2_000);
      await room.kick();
    }
    expect(room.isCompleted).toBe(true);
    expect(completed.length).toBe(1);
  });

  it("public view in all-ai mode never contains private intel", async () => {
    const clock = new FakeClock(0);
    const manager = new RoomManager({
      runtime,
      clock,
      agentPool: {
        humanVsAiAgents: () => BUILTIN_AGENTS.slice(0, 4) as never,
        allAiAgents: () => BUILTIN_AGENTS.slice(0, 4) as never,
      },
    });
    const { events } = collectEvents();
    const room = manager.createAllAi({ matchId: "demo2", seed: "demo-2", events, startPaused: false });
    clock.advanceBy(5_000);
    await room.kick();
    const view = room.viewForPrincipal("anyone") as PublicView;
    expect(view.viewer).toBe("public");
    const json = JSON.stringify(view);
    expect(json).not.toContain("privateIntel");
    expect(json).not.toContain("hiddenProfile");
  });

  function createDemoManager(clock: FakeClock) {
    return new RoomManager({
      runtime,
      clock,
      agentPool: {
        humanVsAiAgents: () => BUILTIN_AGENTS.slice(0, 4) as never,
        allAiAgents: () => BUILTIN_AGENTS.slice(0, 4) as never,
      },
    });
  }

  it("new demo starts paused: time passing does not advance the match", async () => {
    const clock = new FakeClock(0);
    const manager = createDemoManager(clock);
    const { events } = collectEvents();
    const room = manager.createAllAi({ matchId: "paused-demo", seed: "p1", events });
    expect(room.demoState.paused).toBe(true);
    clock.advanceBy(120_000);
    await room.kick();
    expect(room.revision).toBe(0);
    expect(room.acceptedEvents.length).toBe(0);
  });

  it("a single step causes exactly one visible transition and stays paused", async () => {
    const clock = new FakeClock(0);
    const manager = createDemoManager(clock);
    const { events } = collectEvents();
    const room = manager.createAllAi({ matchId: "step-demo", seed: "s1", events });
    const first = await room.demoStep();
    expect(first.changed).toBe(true);
    expect(first.revision).toBe(1);
    expect(room.demoState.paused).toBe(true);
    const second = await room.demoStep();
    expect(second.changed).toBe(true);
    expect(second.revision).toBe(2);
    expect(room.demoState.paused).toBe(true);
    clock.advanceBy(120_000);
    expect(room.revision).toBe(2);
  });

  it("repeated steps complete the match and every step changes something", async () => {
    const clock = new FakeClock(0);
    const manager = createDemoManager(clock);
    const { events, completed } = collectEvents();
    const room = manager.createAllAi({ matchId: "step-all", seed: "s2", events });
    let guard = 0;
    for (;;) {
      if (room.isCompleted) break;
      const step = await room.demoStep();
      expect(step.changed).toBe(true);
      if (guard++ > 500) throw new Error("too many steps");
    }
    expect(completed.length).toBe(1);
    expect(room.demoState.paused).toBe(true);
  });

  it("pause halts progress; resume continues automatically at the current speed", async () => {
    const clock = new FakeClock(0);
    const manager = createDemoManager(clock);
    const { events } = collectEvents();
    const room = manager.createAllAi({ matchId: "pr-demo", seed: "s3", events });
    room.setDemoPaused(false);
    let guard = 0;
    while (room.revision === 0 && guard++ < 20) {
      clock.advanceBy(50);
      await room.kick();
    }
    const runningRevision = room.revision;
    expect(runningRevision).toBeGreaterThan(0);
    room.setDemoPaused(true);
    const frozenRevision = room.revision;
    const frozenEvents = room.acceptedEvents.length;
    clock.advanceBy(600_000);
    expect(room.revision).toBe(frozenRevision);
    expect(room.acceptedEvents.length).toBe(frozenEvents);
    room.setDemoPaused(false);
    guard = 0;
    while (room.revision === frozenRevision && guard++ < 20) {
      clock.advanceBy(50);
      await room.kick();
    }
    expect(room.revision).toBeGreaterThan(frozenRevision);
  });

  it("step, 1x and 8x produce identical core event sequences and final hashes", async () => {
    const runMatch = async (mode: "step" | "speed1" | "speed8") => {
      const clock = new FakeClock(0);
      const manager = createDemoManager(clock);
      const { events } = collectEvents();
      const room = manager.createAllAi({ matchId: "det-uniform", seed: "det-seed", events });
      if (mode === "step") {
        let guard = 0;
        while (!room.isCompleted && guard++ < 500) {
          await room.demoStep();
        }
      } else {
        room.setDemoSpeed(mode === "speed1" ? 1 : 8);
        room.setDemoPaused(false);
        let guard = 0;
        while (!room.isCompleted && guard++ < 500) {
          clock.advanceBy(5_000);
          await room.kick();
        }
      }
      return {
        hash: room.snapshot().stateHash,
        eventTypes: room.acceptedEvents.map((e) => `${e.type}:${JSON.stringify(e.payload)}`),
        completed: room.isCompleted,
      };
    };
    const a = await runMatch("step");
    const b = await runMatch("speed1");
    const c = await runMatch("speed8");
    expect(a.completed).toBe(true);
    expect(b.completed).toBe(true);
    expect(c.completed).toBe(true);
    expect(a.hash).toBe(b.hash);
    expect(b.hash).toBe(c.hash);
    expect(a.eventTypes).toEqual(b.eventTypes);
    expect(b.eventTypes).toEqual(c.eventTypes);
  });
});
