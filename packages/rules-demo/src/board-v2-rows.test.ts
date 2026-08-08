import { describe, expect, it } from "vitest";
import { compileDemoV2 } from "@qiju/rules-demo";
import {
  createMatch,
  transition,
  hashState,
  type MatchState,
  SEAT_IDS,
} from "@qiju/game-core";

const runtimeV2 = compileDemoV2();

function createAuction(seed: string): MatchState {
  let current = createMatch({ matchId: `m-${seed}`, seed, runtime: runtimeV2 });
  for (const seatId of SEAT_IDS) {
    const r = transition(runtimeV2, current, {
      kind: "select_loadout",
      seatId,
      analystId: "analyst.surveyor",
      toolPackageId: "kit.survey",
    });
    if (r.kind !== "accepted") throw new Error("select failed");
    current = r.nextState;
    const r2 = transition(runtimeV2, current, { kind: "lock_setup", seatId });
    if (r2.kind !== "accepted") throw new Error("lock failed");
    current = r2.nextState;
  }
  return current;
}

function occupiedRowSpan(state: MatchState): number {
  const board = state.lot!.board!;
  let maxY = -1;
  for (const p of board.placements) {
    for (const c of p.cells) maxY = Math.max(maxY, c.y);
  }
  return maxY + 1;
}

// THE-35: occupied-row spread. The dense top-packing layout collapsed 66.4% of
// lots into 3-4 occupied rows on a 20-row board; board-v2.test.ts never
// asserted occupied-row span, so the skew shipped undetected. These tests pin
// the 6-15 row target, the 8-12 slot count, and the layout safety invariants.
describe("v2 occupied-row spread (THE-35)", () => {
  it("compiled runtime keeps the 6-15 occupied-row target on the board policy", () => {
    expect(runtimeV2.lotPolicy.board).toMatchObject({
      width: 10,
      height: 20,
      minOccupiedRows: 6,
      maxOccupiedRows: 15,
    });
    expect(runtimeV2.lotPolicy.countMin).toBe(8);
    expect(runtimeV2.lotPolicy.countMax).toBe(12);
  });

  it("1000-seed corpus: slot count stays 8-12 and occupied rows land in 6-15", () => {
    const spanHistogram = new Map<number, number>();
    for (let i = 0; i < 1000; i++) {
      const state = createAuction(`v2-rows-${i}`);
      const lot = state.lot!;
      expect(lot.slots.length).toBeGreaterThanOrEqual(8);
      expect(lot.slots.length).toBeLessThanOrEqual(12);
      const board = lot.board!;
      expect(board.placements.length).toBe(lot.slots.length);

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

      const span = occupiedRowSpan(state);
      expect(span).toBeGreaterThanOrEqual(6);
      expect(span).toBeLessThanOrEqual(15);
      spanHistogram.set(span, (spanHistogram.get(span) ?? 0) + 1);
    }
    // The bug signature was a heavy skew to 3-4 rows (66.4% of seeds). Guard
    // against regressing to a narrow band: the corpus must use most of the
    // 6-15 target range, not collapse onto a single span.
    expect(spanHistogram.size).toBeGreaterThanOrEqual(8);
    expect((spanHistogram.get(3) ?? 0) + (spanHistogram.get(4) ?? 0)).toBe(0);
  }, 120_000);

  it("spread layout stays deterministic: same seed gives identical lot and hash", () => {
    for (let i = 0; i < 20; i++) {
      const a = createAuction(`v2-rows-det-${i}`);
      const b = createAuction(`v2-rows-det-${i}`);
      expect(a.lot).toEqual(b.lot);
      expect(hashState(a)).toBe(hashState(b));
    }
  });
});
