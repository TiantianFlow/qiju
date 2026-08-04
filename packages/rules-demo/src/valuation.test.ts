import { describe, expect, it } from "vitest";
import {
  createMatch,
  observePublic,
  transition,
  type MatchState,
  type SeatId,
} from "@qiju/game-core";
import {
  cellFloor,
  compileDemoV2,
  estimateConservativeValue,
  tierFloor,
} from "./index.js";

const runtime = compileDemoV2();

function runSetup(state: MatchState): MatchState {
  let current = state;
  for (const seatId of ["seat1", "seat2", "seat3", "seat4"] as SeatId[]) {
    const select = transition(runtime, current, {
      kind: "select_loadout",
      seatId,
      analystId: "analyst.appraiser",
      toolPackageId: "kit.appraisal",
    });
    if (select.kind !== "accepted") throw new Error(`select rejected: ${select.code}`);
    current = select.nextState;
    const lock = transition(runtime, current, { kind: "lock_setup", seatId });
    if (lock.kind !== "accepted") throw new Error(`lock rejected: ${lock.code}`);
    current = lock.nextState;
  }
  return current;
}

describe("conservative valuation engine", () => {
  it("exposes positive cell and tier floors from the catalog", () => {
    expect(cellFloor(runtime)).toBeGreaterThan(0);
    expect(tierFloor(runtime, "documented")).toBeLessThanOrEqual(tierFloor(runtime, "scarce"));
    expect(tierFloor(runtime, "scarce")).toBeLessThanOrEqual(tierFloor(runtime, "exceptional"));
    expect(tierFloor(runtime, "exceptional")).toBeLessThanOrEqual(tierFloor(runtime, "singular"));
  });

  it("starts at zero with empty knowledge (unknown cells excluded)", () => {
    let state = createMatch({ matchId: "val-empty", seed: "val-seed-1", runtime });
    state = runSetup(state);
    const estimate = estimateConservativeValue(runtime, state, new Map());
    expect(estimate).toBe(0);
    // Public knowledge may already include opening intel; estimate stays a finite number.
    expect(observePublic(runtime, state).estimatedValue).toBeGreaterThanOrEqual(0);
  });

  it("completed public view estimatedValue equals the true lot sum", () => {
    let state = createMatch({ matchId: "val-done", seed: "val-seed-2", runtime });
    state = runSetup(state);
    const trueSum = state.lot!.slots.reduce(
      (sum, slot) => sum + (runtime.catalog.get(slot.itemId)?.value ?? 0),
      0,
    );
    const completed = {
      ...state,
      phase: {
        kind: "completed" as const,
        result: {
          acquisition: {},
          economic: [],
          training: [],
        },
      },
    };
    expect(observePublic(runtime, completed).estimatedValue).toBe(trueSum);
  });

  it("shape-only then tier-known is monotonic for a single object", () => {
    let state = createMatch({ matchId: "val-tier", seed: "val-seed-3", runtime });
    state = runSetup(state);
    const slot = state.lot!.slots[0]!;
    const item = runtime.catalog.get(slot.itemId)!;
    const placement = state.lot!.board!.placements.find((p) => p.slotId === slot.slotId)!;
    const scrap = cellFloor(runtime);

    const shapeOnly = estimateConservativeValue(
      runtime,
      state,
      new Map([[slot.slotId, { shape: item.shapeId }]]),
    );
    expect(shapeOnly).toBe(placement.cells.length * scrap);

    const tierAndShape = estimateConservativeValue(
      runtime,
      state,
      new Map([[slot.slotId, { shape: item.shapeId, tier: item.tier }]]),
    );
    expect(tierAndShape).toBeGreaterThanOrEqual(shapeOnly);
    expect(tierAndShape).toBe(Math.max(tierFloor(runtime, item.tier), placement.cells.length * scrap));

    const identified = estimateConservativeValue(
      runtime,
      state,
      new Map([[slot.slotId, { identity: item.id, shape: item.shapeId, tier: item.tier }]]),
    );
    expect(identified).toBe(item.value);
    expect(identified).toBeGreaterThanOrEqual(tierAndShape);
  });
});
