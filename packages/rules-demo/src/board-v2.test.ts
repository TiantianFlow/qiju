import { describe, expect, it } from "vitest";
import { compileDemoV2 } from "@qiju/rules-demo";
import {
  createMatch,
  transition,
  observePublic,
  observeSeat,
  legalActions,
  hashState,
  candidatesForSlot,
  type GameCommand,
  type MatchState,
  SEAT_IDS,
} from "@qiju/game-core";

const runtimeV2 = compileDemoV2();

function lockAllSeats(
  state: MatchState,
  loadout: { analystId: "analyst.surveyor" | "analyst.cataloger" | "analyst.appraiser" | "analyst.statistician"; toolPackageId: "kit.survey" | "kit.catalog" | "kit.appraisal" } = {
    analystId: "analyst.surveyor",
    toolPackageId: "kit.survey",
  },
): MatchState {
  let current = state;
  for (const seatId of SEAT_IDS) {
    const seat = current.seats.find((s) => s.seatId === seatId)!;
    if (!seat.analystId) {
      const cmd: GameCommand = {
        kind: "select_loadout",
        seatId,
        analystId: loadout.analystId,
        toolPackageId: loadout.toolPackageId,
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

function lockSeatsWithLoadouts(
  state: MatchState,
  loadouts: Partial<
    Record<
      (typeof SEAT_IDS)[number],
      {
        analystId: "analyst.surveyor" | "analyst.cataloger" | "analyst.appraiser" | "analyst.statistician";
        toolPackageId: "kit.survey" | "kit.catalog" | "kit.appraisal";
      }
    >
  >,
): MatchState {
  let current = state;
  for (const seatId of SEAT_IDS) {
    const loadout = loadouts[seatId] ?? {
      analystId: "analyst.surveyor" as const,
      toolPackageId: "kit.survey" as const,
    };
    const seat = current.seats.find((s) => s.seatId === seatId)!;
    if (!seat.analystId) {
      const r = transition(runtimeV2, current, {
        kind: "select_loadout",
        seatId,
        analystId: loadout.analystId,
        toolPackageId: loadout.toolPackageId,
      });
      if (r.kind !== "accepted") throw new Error("select failed");
      current = r.nextState;
    }
    const r2 = transition(runtimeV2, current, { kind: "lock_setup", seatId });
    if (r2.kind !== "accepted") throw new Error("lock failed");
    current = r2.nextState;
  }
  return current;
}

function createAuction(
  seed: string,
  loadout?: {
    analystId: "analyst.surveyor" | "analyst.cataloger" | "analyst.appraiser" | "analyst.statistician";
    toolPackageId: "kit.survey" | "kit.catalog" | "kit.appraisal";
  },
): MatchState {
  const state = createMatch({ matchId: `m-${seed}`, seed, runtime: runtimeV2 });
  if (!loadout) return lockAllSeats(state);
  return lockSeatsWithLoadouts(state, {
    seat1: loadout,
    seat2: { analystId: "analyst.surveyor", toolPackageId: "kit.survey" },
    seat3: { analystId: "analyst.surveyor", toolPackageId: "kit.survey" },
    seat4: { analystId: "analyst.surveyor", toolPackageId: "kit.survey" },
  });
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

  it("100,000-seed corpus: no layout failure, all rectangular and non-overlapping", () => {
    for (let i = 0; i < 100_000; i++) {
      const state = createMatch({ matchId: `c${i}`, seed: `v2-100k-${i}`, runtime: runtimeV2 });
      let current = state;
      for (const seatId of SEAT_IDS) {
        const r = transition(runtimeV2, current, {
          kind: "select_loadout",
          seatId,
          analystId: "analyst.surveyor",
          toolPackageId: "kit.survey",
        });
        if (r.kind !== "accepted") throw new Error(`select failed at seed ${i}`);
        current = r.nextState;
        const r2 = transition(runtimeV2, current, { kind: "lock_setup", seatId });
        if (r2.kind !== "accepted") throw new Error(`lock failed at seed ${i}`);
        current = r2.nextState;
      }
      const board = current.lot!.board!;
      const occupied = new Uint8Array(board.width * board.height);
      for (const p of board.placements) {
        const xs = p.cells.map((c) => c.x);
        const ys = p.cells.map((c) => c.y);
        const w = Math.max(...xs) - Math.min(...xs) + 1;
        const h = Math.max(...ys) - Math.min(...ys) + 1;
        if (p.cells.length !== w * h) throw new Error(`non-rect placement at seed ${i}`);
        for (const c of p.cells) {
          const key = c.y * board.width + c.x;
          if (occupied[key]) throw new Error(`overlap at seed ${i}`);
          occupied[key] = 1;
        }
      }
    }
  }, 300_000);
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
  it("cataloger category-only facts appear on owning seat board with stable anchor and no cells", () => {
    const state = createAuction("v2-cat-overlay-1", {
      analystId: "analyst.cataloger",
      toolPackageId: "kit.catalog",
    });
    const seatView = observeSeat(runtimeV2, state, "seat1");
    const pubView = observePublic(runtimeV2, state);
    const categoryOnly = seatView.board!.revealedObjects.filter(
      (o) => o.category !== undefined && o.cells === undefined && o.tier === undefined && o.identity === undefined,
    );
    expect(categoryOnly.length).toBeGreaterThan(0);
    for (const o of categoryOnly) {
      expect(o.category).toBeDefined();
      expect(o.anchor).toBeDefined();
      expect(o.cells).toBeUndefined();
      expect(o.revealId).not.toMatch(/S0\d/);
      expect(pubView.board!.revealedObjects.some((p) => p.revealId === o.revealId && p.category === o.category)).toBe(
        false,
      );
    }
    const otherSeat = observeSeat(runtimeV2, state, "seat2");
    for (const o of categoryOnly) {
      const other = otherSeat.board!.revealedObjects.find((x) => x.revealId === o.revealId);
      expect(other?.category).toBeUndefined();
    }
    const serialized = JSON.stringify(seatView);
    expect(serialized).toContain('"category"');
    expect(serialized).not.toMatch(/S0\d/);
  });
});

describe("value-only private overlay", () => {
  it("appraiser value-only facts appear with stable anchor, no footprint cells, seat-private only", () => {
    const state = createAuction("v2-val-overlay-1", {
      analystId: "analyst.appraiser",
      toolPackageId: "kit.appraisal",
    });
    const seatView = observeSeat(runtimeV2, state, "seat1");
    const pubView = observePublic(runtimeV2, state);
    const valueOnly = seatView.board!.revealedObjects.filter(
      (o) => o.exactValue !== undefined && o.cells === undefined && o.identity === undefined,
    );
    expect(valueOnly.length).toBeGreaterThan(0);
    for (const o of valueOnly) {
      expect(o.exactValue).toBeDefined();
      expect(o.anchor).toBeDefined();
      expect(o.cells).toBeUndefined();
      expect(pubView.board!.revealedObjects.some((p) => p.revealId === o.revealId && p.exactValue === o.exactValue)).toBe(
        false,
      );
    }
    const dto = JSON.stringify(seatView.board);
    expect(dto).toContain('"exactValue"');
    expect(dto).toContain('"anchor"');
  });
});

describe("v2 rectangular shape knowledge and candidate closure", () => {
  it("catalog shapeIds encode real footprints and are not overloaded single", () => {
    const shapes = new Set(runtimeV2.catalogSorted.map((i) => i.shapeId));
    expect(shapes.has("single")).toBe(false);
    expect([...shapes].every((s) => /^rect\.\d+x\d+$/.test(s))).toBe(true);
    expect(shapes.has("rect.2x1")).toBe(true);
    expect(shapes.has("rect.1x2")).toBe(true);
    expect(shapes.has("rect.2x2")).toBe(true);
    expect(shapes.has("rect.3x2")).toBe(true);
  });

  it("shape facts and candidate closure filter by revealed footprint dimensions", () => {
    const state = createAuction("v2-shape-close-1", {
      analystId: "analyst.surveyor",
      toolPackageId: "kit.survey",
    });
    const seatView = observeSeat(runtimeV2, state, "seat1");
    const shaped = seatView.board!.revealedObjects.filter((o) => o.cells && o.cells.length > 0);
    expect(shaped.length).toBeGreaterThan(0);
    const dims = new Set<string>();
    for (const o of shaped) {
      const xs = o.cells!.map((c) => c.x);
      const ys = o.cells!.map((c) => c.y);
      const w = Math.max(...xs) - Math.min(...xs) + 1;
      const h = Math.max(...ys) - Math.min(...ys) + 1;
      dims.add(`${w}x${h}`);
      const slotId = Object.entries(state.revealTokenBySlot ?? {}).find(([, tok]) => tok === o.revealId)?.[0];
      expect(slotId).toBeDefined();
      const range = candidatesForSlot(runtimeV2, state, "seat1", slotId as never);
      expect(range.candidateIds.length).toBeLessThan(runtimeV2.catalogSorted.length);
      for (const id of range.candidateIds) {
        const item = runtimeV2.catalog.get(id)!;
        expect(item.footprint).toEqual({ width: w, height: h });
        expect(item.shapeId).toBe(`rect.${w}x${h}`);
      }
      expect(JSON.stringify(o)).not.toMatch(/"single"/);
    }
    expect(dims.size).toBeGreaterThanOrEqual(1);
    const pubIntel = JSON.stringify(seatView.publicIntel);
    expect(pubIntel).not.toMatch(/"shapeId":"single"/);
  });
});
