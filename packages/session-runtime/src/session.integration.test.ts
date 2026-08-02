import { describe, expect, it } from "vitest";
import { compileDemoV2 } from "@qiju/rules-demo";
import { BUILTIN_AGENTS } from "@qiju/agents";
import { FakeClock, RoomManager, type RoomEvents } from "@qiju/session-runtime";

const runtime = compileDemoV2();

function silentEvents(): RoomEvents {
  return { onViewUpdate() {}, onMatchCompleted() {}, onEvents() {} };
}

function manager(clock: FakeClock): RoomManager {
  return new RoomManager({
    runtime,
    clock,
    agentPool: {
      humanVsAiAgents: () => BUILTIN_AGENTS.slice(0, 4) as never,
      allAiAgents: () => BUILTIN_AGENTS.slice(0, 4) as never,
    },
  });
}

describe("session integration: demo lifecycle on v2", () => {
  it("all-AI demo on v2 completes with checkpoints and a fully revealed board", async () => {
    const clock = new FakeClock(0);
    const room = manager(clock).createAllAi({
      matchId: "it-v2-demo",
      seed: "it-v2-seed",
      events: silentEvents(),
    });
    await room.initializeDemoToAuctionReady();
    expect(room.demoState.presentation?.kind).toBe("auction-ready");

    const checkpointKinds = new Set<string>();
    let guard = 0;
    for (;;) {
      if (room.isCompleted && room.demoState.presentation?.kind === "completed") break;
      const step = await room.demoStep();
      expect(step.changed).toBe(true);
      checkpointKinds.add(step.checkpoint!.kind);
      if (guard++ > 60) throw new Error("too many checkpoints");
    }
    expect(checkpointKinds.has("bids-revealed") || checkpointKinds.has("round-outcome")).toBe(true);

    const view = room.publicView();
    const board = view.board!;
    expect(board.revealedObjects.length).toBe(room.currentState.lot!.slots.length);
    for (const obj of board.revealedObjects) {
      expect(obj.identity).toBeDefined();
      const xs = obj.cells!.map((c) => c.x);
      const ys = obj.cells!.map((c) => c.y);
      const w = Math.max(...xs) - Math.min(...xs) + 1;
      const h = Math.max(...ys) - Math.min(...ys) + 1;
      expect(obj.cells!.length).toBe(w * h);
    }
  });

  it("step/1x/8x on v2 produce identical core event sequences and final hash", async () => {
    const run = async (mode: "step" | "s1" | "s8") => {
      const clock = new FakeClock(0);
      const room = manager(clock).createAllAi({
        matchId: "it-v2-det",
        seed: "it-v2-det-seed",
        events: silentEvents(),
      });
      await room.initializeDemoToAuctionReady();
      if (mode === "step") {
        let guard = 0;
        while (!(room.isCompleted && room.demoState.presentation?.kind === "completed") && guard++ < 200) {
          await room.demoStep();
        }
      } else {
        room.setDemoSpeed(mode === "s1" ? 1 : 8);
        room.setDemoPaused(false);
        let guard = 0;
        while (!(room.isCompleted && room.demoState.presentation?.kind === "completed") && guard++ < 2000) {
          clock.advanceBy(5_000);
          await room.kick();
        }
      }
      return {
        hash: room.snapshot().stateHash,
        events: room.acceptedEvents.map((e) => `${e.type}:${JSON.stringify(e.payload)}`),
        completed: room.isCompleted,
      };
    };
    const a = await run("step");
    const b = await run("s1");
    const c = await run("s8");
    expect(a.completed && b.completed && c.completed).toBe(true);
    expect(a.hash).toBe(b.hash);
    expect(b.hash).toBe(c.hash);
    expect(a.events).toEqual(b.events);
    expect(b.events).toEqual(c.events);
  });

  it("initial v2 seat observation over the session boundary has no hidden slot data", async () => {
    const clock = new FakeClock(0);
    const room = manager(clock).createAllAi({
      matchId: "it-v2-secret",
      seed: "it-v2-secret-seed",
      events: silentEvents(),
    });
    await room.initializeDemoToAuctionReady();
    const view = room.viewForPrincipal("observer");
    const json = JSON.stringify(view);
    expect(json).not.toMatch(/"slotId"/);
    expect(json).not.toMatch(/S0\d/);
  });
});
