import { describe, expect, it } from "vitest";
import { compileDemoV0, compileDemoV1 } from "@qiju/rules-demo";
import {
  createMatch,
  transition,
  observePublic,
  observeSeat,
  hashState,
  type GameCommand,
  type MatchState,
  SEAT_IDS,
} from "@qiju/game-core";

const runtimeV1 = compileDemoV1();

function lockAllSeats(state: MatchState): MatchState {
  let current = state;
  for (const seatId of SEAT_IDS) {
    const seat = current.seats.find((s) => s.seatId === seatId)!;
    if (!seat.analystId) {
      const cmd: GameCommand = {
        kind: "select_loadout",
        seatId,
        analystId: "analyst.surveyor",
        toolPackageId: "kit.survey",
      };
      const r = transition(runtimeV1, current, cmd);
      if (r.kind !== "accepted") throw new Error("select failed");
      current = r.nextState;
    }
    const r2 = transition(runtimeV1, current, { kind: "lock_setup", seatId });
    if (r2.kind !== "accepted") throw new Error("lock failed");
    current = r2.nextState;
  }
  return current;
}

function createAuction(seed: string): MatchState {
  const state = createMatch({ matchId: `m-${seed}`, seed, runtime: runtimeV1 });
  return lockAllSeats(state);
}

describe("content.synthetic.v1 lot generation", () => {
  it("same seed produces identical count, identities and placements", () => {
    const a = createAuction("layout-seed-1");
    const b = createAuction("layout-seed-1");
    expect(a.lot).toEqual(b.lot);
    expect(a.lot!.board).toBeDefined();
  });

  it("item count stays within 8-12 across seeds", () => {
    for (let i = 0; i < 200; i++) {
      const state = createAuction(`count-seed-${i}`);
      const n = state.lot!.slots.length;
      expect(n).toBeGreaterThanOrEqual(8);
      expect(n).toBeLessThanOrEqual(12);
    }
  });

  it("placements are in-bounds, non-overlapping and succeed across seed corpus", () => {
    for (let i = 0; i < 500; i++) {
      const state = createAuction(`layout-corpus-${i}`);
      const board = state.lot!.board!;
      const occupied = new Set<number>();
      for (const p of board.placements) {
        expect(p.cells.length).toBeGreaterThan(0);
        for (const c of p.cells) {
          expect(c.x).toBeGreaterThanOrEqual(0);
          expect(c.y).toBeGreaterThanOrEqual(0);
          expect(c.x).toBeLessThan(board.width);
          expect(c.y).toBeLessThan(board.height);
          const key = c.y * board.width + c.x;
          expect(occupied.has(key)).toBe(false);
          occupied.add(key);
        }
      }
    }
  });
});

describe("concealed board projection", () => {
  it("initial view has no item count leak and no revealed objects", () => {
    const state = createAuction("conceal-seed-1");
    const view = observePublic(runtimeV1, state);
    expect(view.board).toBeDefined();
    const board = view.board!;
    expect(board.revealedObjects).toHaveLength(0);
    expect(board.concealedCells).toBe(board.width * board.height);
    const serialized = JSON.stringify(board);
    expect(serialized).not.toMatch(/itemCount/);
    expect(serialized).not.toMatch(/S0\d/);
    expect(serialized).not.toContain(String(state.lot!.slots.length));
  });

  it("seat view also does not leak count through board", () => {
    const state = createAuction("conceal-seed-2");
    const view = observeSeat(runtimeV1, state, "seat1");
    const serialized = JSON.stringify(view.board);
    expect(serialized).not.toMatch(/itemCount/);
  });
});

describe("weighted public intel pool", () => {
  it("same seed yields identical public effect id and targets", () => {
    const a = createAuction("pool-seed-1");
    const b = createAuction("pool-seed-1");
    const pubA = a.intel.filter((r) => r.visibility.kind === "public");
    const pubB = b.intel.filter((r) => r.visibility.kind === "public");
    expect(pubA.map((r) => r.effectInstanceId)).toEqual(pubB.map((r) => r.effectInstanceId));
    expect(pubA.map((r) => r.fact)).toEqual(pubB.map((r) => r.fact));
  });

  it("seed corpus reaches at least two effect families", () => {
    const effects = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const state = createAuction(`pool-corpus-${i}`);
      for (const r of state.intel) {
        if (r.visibility.kind === "public" && r.round === 1) {
          effects.add(r.effectInstanceId.split(":")[0]!);
        }
      }
    }
    expect(effects.size).toBeGreaterThanOrEqual(2);
    for (const id of effects) {
      expect(id.startsWith("intel.public.pool.")).toBe(true);
    }
  });
});

describe("determinism", () => {
  it("full hash matches for identical seed after lot generation", () => {
    const a = createAuction("hash-seed-1");
    const b = createAuction("hash-seed-1");
    expect(hashState(a)).toBe(hashState(b));
  });
});

describe("v0 regression", () => {
  it("v0 still compiles and generates 10 fixed slots without board", () => {
    const runtimeV0 = compileDemoV0();
    const state = createMatch({ matchId: "v0-check", seed: "v0-seed", runtime: runtimeV0 });
    let current = state;
    for (const seatId of SEAT_IDS) {
      const r = transition(runtimeV0, current, {
        kind: "select_loadout",
        seatId,
        analystId: "analyst.surveyor",
        toolPackageId: "kit.survey",
      });
      if (r.kind !== "accepted") throw new Error("select failed");
      current = r.nextState;
      const r2 = transition(runtimeV0, current, { kind: "lock_setup", seatId });
      if (r2.kind !== "accepted") throw new Error("lock failed");
      current = r2.nextState;
    }
    expect(current.lot!.slots).toHaveLength(10);
    expect(current.lot!.board).toBeUndefined();
    const view = observePublic(runtimeV0, current);
    expect(view.board).toBeUndefined();
    expect(view.slots).toHaveLength(10);
  });
});
