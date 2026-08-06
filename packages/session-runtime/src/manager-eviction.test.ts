import { describe, expect, it } from "vitest";
import { compileDemoV0 } from "@qiju/rules-demo";
import { BUILTIN_AGENTS } from "@qiju/agents";
import { FakeClock, RoomManager, type RoomEvents } from "@qiju/session-runtime";

const runtime = compileDemoV0();

function noopEvents(): RoomEvents {
  return {
    onViewUpdate() {},
    onMatchCompleted() {},
    onEvents() {},
  };
}

function makeManager(
  clock: FakeClock,
  eviction: {
    completedGraceMs?: number;
    idleTimeoutMs?: number;
    maxRooms?: number;
    sweepIntervalMs?: number;
  },
  onEvict?: (matchId: string) => void,
): RoomManager {
  return new RoomManager({
    runtime,
    clock,
    agentPool: {
      humanVsAiAgents: () => BUILTIN_AGENTS.slice(0, 4) as never,
      allAiAgents: () => BUILTIN_AGENTS.slice(0, 4) as never,
    },
    eviction,
    ...(onEvict ? { onEvict } : {}),
  });
}

describe("RoomManager eviction (THE-24)", () => {
  it("frees a completed match after its grace period, not before", async () => {
    const clock = new FakeClock(0);
    const evicted: string[] = [];
    const manager = makeManager(
      clock,
      { completedGraceMs: 5_000, idleTimeoutMs: 10_000_000, maxRooms: 500, sweepIntervalMs: 500 },
      (id) => evicted.push(id),
    );
    const room = manager.createAllAi({ matchId: "m-complete", seed: "s1", events: noopEvents(), startPaused: false });
    room.setDemoSpeed(8);
    let guard = 0;
    while (!room.isCompleted && guard++ < 400) {
      clock.advanceBy(2_000);
      await room.kick();
    }
    expect(room.isCompleted).toBe(true);

    // Right after completion, still within grace - must still be reachable.
    clock.advanceBy(1_000);
    expect(manager.get("m-complete")).toBeDefined();
    expect(evicted).not.toContain("m-complete");

    // Past the grace period - the periodic sweep should have freed it.
    clock.advanceBy(10_000);
    expect(manager.get("m-complete")).toBeUndefined();
    expect(evicted).toContain("m-complete");
  });

  it("frees an idle, never-completed match only after the idle timeout - not before", () => {
    const clock = new FakeClock(0);
    const evicted: string[] = [];
    const manager = makeManager(
      clock,
      { completedGraceMs: 10_000_000, idleTimeoutMs: 5_000, maxRooms: 500, sweepIntervalMs: 500 },
      (id) => evicted.push(id),
    );
    manager.createHumanVsAi({
      matchId: "m-idle-2",
      seed: "s3",
      humanPrincipalId: "p1",
      events: noopEvents(),
    });

    // Advance under the threshold without touching via get()/touch() at all.
    clock.advanceBy(4_000);
    expect(evicted).not.toContain("m-idle-2");

    // Advance past the threshold - now it should be gone.
    clock.advanceBy(2_000);
    expect(evicted).toContain("m-idle-2");
    expect(manager.get("m-idle-2")).toBeUndefined();
  });

  it("an ACTIVE match (repeatedly touched) is never evicted, even long past what would otherwise be the idle timeout", () => {
    const clock = new FakeClock(0);
    const evicted: string[] = [];
    const manager = makeManager(
      clock,
      { completedGraceMs: 10_000_000, idleTimeoutMs: 5_000, maxRooms: 500, sweepIntervalMs: 500 },
      (id) => evicted.push(id),
    );
    manager.createHumanVsAi({
      matchId: "m-active",
      seed: "s4",
      humanPrincipalId: "p1",
      events: noopEvents(),
    });

    // Simulate a long, active session: touch well inside every idle window,
    // for far longer than the idle timeout would otherwise tolerate.
    for (let i = 0; i < 50; i++) {
      clock.advanceBy(3_000); // < idleTimeoutMs each step
      manager.touch("m-active");
    }
    // Total elapsed: 150,000ms = 30x the idle timeout.
    expect(evicted).not.toContain("m-active");
    expect(manager.get("m-active")).toBeDefined();

    // And a plain get() (e.g. a view-fetch or reconnect) also counts as
    // activity, not just the explicit touch() calls above.
    clock.advanceBy(3_000);
    expect(manager.get("m-active")).toBeDefined();
    clock.advanceBy(3_000);
    expect(manager.get("m-active")).toBeDefined();
    expect(evicted).not.toContain("m-active");
  });

  it("reconnecting within the grace window after a disconnect still works (get() after a quiet stretch under the idle timeout)", () => {
    const clock = new FakeClock(0);
    const manager = makeManager(clock, { idleTimeoutMs: 10_000, completedGraceMs: 10_000_000, maxRooms: 500, sweepIntervalMs: 500 });
    manager.createHumanVsAi({
      matchId: "m-reconnect",
      seed: "s5",
      humanPrincipalId: "p1",
      events: noopEvents(),
    });
    // A brief drop: nothing touches the room for a few seconds, well under
    // the idle timeout, then a reconnect (get()) arrives.
    clock.advanceBy(4_000);
    const room = manager.get("m-reconnect");
    expect(room).toBeDefined();
    expect(room?.matchId).toBe("m-reconnect");
  });

  it("hard cap evicts the least-recently-touched room when a new one is created over the ceiling", () => {
    const clock = new FakeClock(0);
    const evicted: string[] = [];
    const manager = makeManager(
      clock,
      { completedGraceMs: 10_000_000, idleTimeoutMs: 10_000_000, maxRooms: 3, sweepIntervalMs: 500 },
      (id) => evicted.push(id),
    );
    manager.createHumanVsAi({ matchId: "r1", seed: "a", humanPrincipalId: "p1", events: noopEvents() });
    clock.advanceBy(100);
    manager.createHumanVsAi({ matchId: "r2", seed: "b", humanPrincipalId: "p1", events: noopEvents() });
    clock.advanceBy(100);
    manager.createHumanVsAi({ matchId: "r3", seed: "c", humanPrincipalId: "p1", events: noopEvents() });
    clock.advanceBy(100);
    // Touch r1 so it's no longer the least-recently-touched.
    manager.touch("r1");
    clock.advanceBy(100);

    // A 4th room pushes the count to 4, over the cap of 3 - r2 (now the
    // least-recently-touched: created before r3, and never touched after
    // r1 was) should be evicted immediately, synchronously at creation.
    manager.createHumanVsAi({ matchId: "r4", seed: "d", humanPrincipalId: "p1", events: noopEvents() });

    expect(evicted).toContain("r2");
    expect(manager.get("r2")).toBeUndefined();
    expect(manager.get("r1")).toBeDefined();
    expect(manager.get("r3")).toBeDefined();
    expect(manager.get("r4")).toBeDefined();
  });

  it("evicting a room makes later access behave like a missing match, not a crash", () => {
    const clock = new FakeClock(0);
    const manager = makeManager(clock, { idleTimeoutMs: 1_000, completedGraceMs: 10_000_000, maxRooms: 500, sweepIntervalMs: 200 });
    manager.createHumanVsAi({ matchId: "m-gone", seed: "s6", humanPrincipalId: "p1", events: noopEvents() });
    clock.advanceBy(2_000);
    expect(() => manager.get("m-gone")).not.toThrow();
    expect(manager.get("m-gone")).toBeUndefined();
    expect(() => manager.touch("m-gone")).not.toThrow();
    expect(() => manager.delete("m-gone")).not.toThrow();
  });
});
