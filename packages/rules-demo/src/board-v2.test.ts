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

describe("completed projection", () => {
  function playToEnd(seed: string): MatchState {
    let state = createAuction(seed);
    for (let i = 0; i < 200 && state.window; i++) {
      const window = state.window;
      const seatId = window.participants.find((p) => !window.bids[p]?.locked);
      if (!seatId) {
        const r = transition(runtimeV2, state, {
          kind: "deadline_reached",
          actionWindowId: window.actionWindowId,
        });
        if (r.kind !== "accepted") break;
        state = r.nextState;
        continue;
      }
      const submit = transition(runtimeV2, state, {
        kind: "submit_bid",
        seatId,
        amount: 0,
        actionWindowId: window.actionWindowId,
      });
      if (submit.kind !== "accepted") break;
      const lock = transition(runtimeV2, submit.nextState, {
        kind: "lock_bid",
        seatId,
        actionWindowId: window.actionWindowId,
      });
      if (lock.kind !== "accepted") break;
      state = lock.nextState;
    }
    return state;
  }

  it("completed public view enumerates all objects and totals actual value", () => {
    const state = playToEnd("v2-complete-1");
    expect(state.phase.kind).toBe("completed");
    const view = observePublic(runtimeV2, state);
    expect(view.slots.length).toBe(state.lot!.slots.length);
    const objects = view.board!.revealedObjects;
    expect(objects.length).toBe(state.lot!.slots.length);
    const sum = objects.reduce((a, o) => a + (o.exactValue ?? 0), 0);
    expect(sum).toBe(state.lot!.actualValue);
    for (const o of objects) {
      expect(o.identity).toBeDefined();
      expect(o.cells).toBeDefined();
      expect(o.tier).toBeDefined();
    }
  });

  it("mid-auction public view still does not enumerate hidden objects", () => {
    const state = createAuction("v2-complete-2");
    const view = observePublic(runtimeV2, state);
    expect(view.slots.length).toBe(0);
    expect(view.board!.revealedObjects.length).toBeLessThan(state.lot!.slots.length);
  });
});

describe("multi-target public effect aggregation", () => {
  it("a multi-target public effect produces exactly one event with multiple revealIds", () => {
    let found = 0;
    for (let i = 0; i < 80 && found < 3; i++) {
      const state = createAuction(`multi-agg-${i}`);
      const view = observePublic(runtimeV2, state);
      for (const e of view.publicEvents!) {
        if (e.sourceKind !== "auctioneer") continue;
        if (!e.localizationKey.startsWith("event.intel.multi.")) continue;
        found++;
        expect(e.revealIds.length).toBeGreaterThanOrEqual(2);
        const sameInstance = view.publicEvents!.filter(
          (o) => o.effectInstanceId === e.effectInstanceId,
        );
        expect(sameInstance.length).toBe(1);
      }
    }
    expect(found).toBeGreaterThanOrEqual(3);
  });
});

describe("category-only private overlay", () => {
  it("seat-only category reveal updates that seat's board overlay only", () => {
    const state = createAuction("v2-cat-overlay-1");
    const seatView = observeSeat(runtimeV2, state, "seat1");
    const pubView = observePublic(runtimeV2, state);
    const seatObjects = seatView.board!.revealedObjects;
    const pubObjects = pubView.board!.revealedObjects;
    const seatOnly = seatObjects.filter(
      (o) => !pubObjects.some((p) => p.revealId === o.revealId),
    );
    expect(seatOnly.length).toBeGreaterThan(0);
    for (const o of seatOnly) {
      expect(o.revealId).not.toMatch(/S0\d/);
    }
    const otherSeat = observeSeat(runtimeV2, state, "seat2");
    const seat1Tokens = new Set(seatOnly.map((o) => o.revealId));
    for (const o of otherSeat.board!.revealedObjects) {
      if (seat1Tokens.has(o.revealId)) {
        const seat1Obj = seatOnly.find((x) => x.revealId === o.revealId)!;
        expect(Object.keys(o).length).toBeLessThanOrEqual(Object.keys(seat1Obj).length);
      }
    }
  });
});
