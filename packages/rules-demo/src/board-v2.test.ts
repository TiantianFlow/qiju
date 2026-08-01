import { describe, expect, it } from "vitest";
import { compileDemoV2 } from "@qiju/rules-demo";
import {
  createMatch,
  transition,
  observePublic,
  observeSeat,
  legalActions,
  hashState,
  type GameCommand,
  type MatchState,
  SEAT_IDS,
} from "@qiju/game-core";

const runtimeV2 = compileDemoV2();

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
      const r = transition(runtimeV2, current, cmd);
      if (r.kind !== "accepted") throw new Error("select failed");
      current = r.nextState;
    }
    const r2 = transition(runtimeV2, current, { kind: "lock_setup", seatId });
    if (r2.kind !== "accepted") throw new Error("lock failed");
    current = r2.nextState;
  }
  return current;
}

function createAuction(seed: string): MatchState {
  const state = createMatch({ matchId: `m-${seed}`, seed, runtime: runtimeV2 });
  return lockAllSeats(state);
}

describe("content.synthetic.v2 rectangular footprints", () => {
  it("every catalog footprint is an axis-aligned 1-5 rectangle", () => {
    for (const item of runtimeV2.catalogSorted) {
      expect(item.footprint).toBeDefined();
      expect(item.footprint!.width).toBeGreaterThanOrEqual(1);
      expect(item.footprint!.width).toBeLessThanOrEqual(5);
      expect(item.footprint!.height).toBeGreaterThanOrEqual(1);
      expect(item.footprint!.height).toBeLessThanOrEqual(5);
    }
  });

  it("every placement's cells are exactly the width×height cartesian product", () => {
    for (let i = 0; i < 50; i++) {
      const state = createAuction(`rect-seed-${i}`);
      const board = state.lot!.board!;
      for (const p of board.placements) {
        const xs = p.cells.map((c) => c.x);
        const ys = p.cells.map((c) => c.y);
        const w = Math.max(...xs) - Math.min(...xs) + 1;
        const h = Math.max(...ys) - Math.min(...ys) + 1;
        expect(p.cells.length).toBe(w * h);
        const keys = new Set(p.cells.map((c) => `${c.x},${c.y}`));
        for (let dx = 0; dx < w; dx++) {
          for (let dy = 0; dy < h; dy++) {
            expect(keys.has(`${Math.min(...xs) + dx},${Math.min(...ys) + dy}`)).toBe(true);
          }
        }
      }
    }
  });

  it("same seed gives identical identities, footprints, placements and hash", () => {
    const a = createAuction("v2-det-1");
    const b = createAuction("v2-det-1");
    expect(a.lot).toEqual(b.lot);
    expect(hashState(a)).toBe(hashState(b));
  });
});

describe("infallible layout", () => {
  it("regression: layout-stress-10508 succeeds", () => {
    const state = createAuction("layout-stress-10508");
    expect(state.lot!.board!.placements.length).toBe(state.lot!.slots.length);
  });

  it("2000-seed corpus: all placements succeed, in-bounds, non-overlapping", () => {
    for (let i = 0; i < 2000; i++) {
      const state = createAuction(`v2-corpus-${i}`);
      const board = state.lot!.board!;
      const occupied = new Set<number>();
      for (const p of board.placements) {
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
  }, 60_000);
});

describe("v2 secrecy", () => {
  it("initial full PublicView DTO has no hidden slot enumeration or count", () => {
    const state = createAuction("v2-secret-1");
    const view = observePublic(runtimeV2, state);
    const json = JSON.stringify(view);
    expect(json).not.toMatch(/"slotId"/);
    expect(json).not.toMatch(/S0\d/);
    expect(view.slots).toHaveLength(0);
    for (const obj of view.board!.revealedObjects) {
      expect(obj.revealId).not.toMatch(/S0\d/);
    }
  });

  it("all four SeatObservations and agent views conceal slots", () => {
    const state = createAuction("v2-secret-2");
    for (const seatId of SEAT_IDS) {
      const obs = observeSeat(runtimeV2, state, seatId);
      const json = JSON.stringify(obs);
      expect(json).not.toMatch(/"slotId"/);
      expect(json).not.toMatch(/S0\d/);
      expect(obs.slots).toHaveLength(0);
      expect(legalActions(runtimeV2, state, seatId).actions.length).toBeGreaterThan(0);
    }
  });
});
