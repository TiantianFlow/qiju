import { describe, expect, it } from "vitest";
import type {
  EconomicResultEntry,
  MatchResult,
  SeatId,
  TrainingUtilityEntry,
} from "@qiju/game-core";
import {
  POCKET_OPENING_BALANCE,
  pocketBalance,
  winLossRecord,
} from "./index.js";

// ---------------------------------------------------------------------------
// MatchResult builders — every pocket path below goes through real
// engine-shaped MatchResult data, never raw profit number arrays.
// ---------------------------------------------------------------------------

const DEFAULT_DENOMINATOR = 400_000; // 4 * startingBudget, e.g. budget 100,000.

function trainingEntry(
  seatId: SeatId,
  utilityNumerator: number,
  utilityDenominator: number = DEFAULT_DENOMINATOR,
): TrainingUtilityEntry {
  return { seatId, utilityNumerator, utilityDenominator };
}

function economicEntry(
  seatId: SeatId,
  realizedProfit: number,
): EconomicResultEntry {
  return {
    seatId,
    finalWealth: 0,
    realizedProfit,
    bonusReward: 0,
    denseEconomicRank: 1,
  };
}

function matchResult(
  training: readonly TrainingUtilityEntry[],
  economic: readonly EconomicResultEntry[] = [],
): MatchResult {
  return { acquisition: {}, economic: [...economic], training: [...training] };
}

/** A completed match in which `seatId` realized exactly `profit`. */
function matchWithProfit(seatId: SeatId, profit: number): MatchResult {
  return matchResult(
    [trainingEntry(seatId, 0)],
    [economicEntry(seatId, profit)],
  );
}

const SEAT: SeatId = "seat1";
const OTHER_SEAT: SeatId = "seat2";

// ---------------------------------------------------------------------------
// Opening constant and empty history
// ---------------------------------------------------------------------------

describe("POCKET_OPENING_BALANCE", () => {
  it("is one table stake at content.synthetic.v2", () => {
    expect(POCKET_OPENING_BALANCE).toBe(2_000_000);
  });
});

describe("empty history", () => {
  it("returns exactly the opening balance and a zeroed win/loss/push record", () => {
    expect(pocketBalance([], SEAT)).toBe(POCKET_OPENING_BALANCE);
    expect(winLossRecord([], SEAT)).toEqual({
      wins: 0,
      losses: 0,
      pushes: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Single-match outcomes
// ---------------------------------------------------------------------------

describe("single-match outcomes", () => {
  it("a single win adds realized profit and counts one win", () => {
    const results = [matchWithProfit(SEAT, 117_829)];
    expect(pocketBalance(results, SEAT)).toBe(POCKET_OPENING_BALANCE + 117_829);
    expect(winLossRecord(results, SEAT)).toEqual({
      wins: 1,
      losses: 0,
      pushes: 0,
    });
  });

  it("a single loss subtracts realized profit and counts one loss", () => {
    const results = [matchWithProfit(SEAT, -40_000)];
    expect(pocketBalance(results, SEAT)).toBe(POCKET_OPENING_BALANCE - 40_000);
    expect(winLossRecord(results, SEAT)).toEqual({
      wins: 0,
      losses: 1,
      pushes: 0,
    });
  });

  it("a push (realizedProfit = 0) leaves the pocket unchanged and is neither a win nor a loss", () => {
    // The engine emits realizedProfit = 0 for every seat on the no-sale path.
    const results = [matchWithProfit(SEAT, 0)];
    expect(pocketBalance(results, SEAT)).toBe(POCKET_OPENING_BALANCE);
    expect(winLossRecord(results, SEAT)).toEqual({
      wins: 0,
      losses: 0,
      pushes: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// Mixed sequences
// ---------------------------------------------------------------------------

describe("mixed sequences", () => {
  it("sums profit and classifies each match; wins + losses + pushes equals match count", () => {
    const results = [
      matchWithProfit(SEAT, 100_000),
      matchWithProfit(SEAT, -40_000),
      matchWithProfit(SEAT, 0),
      matchWithProfit(SEAT, 25_000),
      matchWithProfit(SEAT, -10_000),
      matchWithProfit(SEAT, 0),
    ];
    const record = winLossRecord(results, SEAT);
    expect(pocketBalance(results, SEAT)).toBe(POCKET_OPENING_BALANCE + 75_000);
    expect(record).toEqual({ wins: 2, losses: 2, pushes: 2 });
    expect(record.wins + record.losses + record.pushes).toBe(results.length);
  });

  it("profit ordering does not affect the final balance (summation is commutative)", () => {
    const profits = [74_150, -12_000, 0, 5_500, -3_250];
    const forward = profits.map((profit) => matchWithProfit(SEAT, profit));
    const reversed = [...profits]
      .reverse()
      .map((profit) => matchWithProfit(SEAT, profit));
    const shuffled = [0, 74_150, -3_250, 5_500, -12_000].map((profit) =>
      matchWithProfit(SEAT, profit),
    );
    const expected =
      POCKET_OPENING_BALANCE + profits.reduce((sum, profit) => sum + profit, 0);
    expect(pocketBalance(forward, SEAT)).toBe(expected);
    expect(pocketBalance(reversed, SEAT)).toBe(expected);
    expect(pocketBalance(shuffled, SEAT)).toBe(expected);
    expect(winLossRecord(forward, SEAT)).toEqual(winLossRecord(reversed, SEAT));
    expect(winLossRecord(forward, SEAT)).toEqual(winLossRecord(shuffled, SEAT));
  });

  it("attributes only the selected seat's realized profit", () => {
    const results = [
      matchResult(
        [trainingEntry(SEAT, 0), trainingEntry(OTHER_SEAT, 0)],
        [economicEntry(SEAT, 74_150), economicEntry(OTHER_SEAT, 9_999_999)],
      ),
      matchResult(
        [trainingEntry(SEAT, 0), trainingEntry(OTHER_SEAT, 0)],
        [economicEntry(SEAT, 0), economicEntry(OTHER_SEAT, -1)],
      ),
    ];
    expect(pocketBalance(results, SEAT)).toBe(POCKET_OPENING_BALANCE + 74_150);
    expect(winLossRecord(results, SEAT)).toEqual({
      wins: 1,
      losses: 0,
      pushes: 1,
    });
    expect(pocketBalance(results, OTHER_SEAT)).toBe(
      POCKET_OPENING_BALANCE + 9_999_998,
    );
    expect(winLossRecord(results, OTHER_SEAT)).toEqual({
      wins: 1,
      losses: 1,
      pushes: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Boundary validation
// ---------------------------------------------------------------------------

describe("pocket input validation", () => {
  it("rejects a missing economic entry for the seat", () => {
    const result = matchResult(
      [trainingEntry(SEAT, 0)],
      [economicEntry(OTHER_SEAT, 1_000)],
    );
    expect(() => pocketBalance([result], SEAT)).toThrow(/no economic entry/);
    expect(() => winLossRecord([result], SEAT)).toThrow(/no economic entry/);
  });

  it("rejects duplicate economic entries for the seat", () => {
    const result = matchResult(
      [trainingEntry(SEAT, 0)],
      [economicEntry(SEAT, 1_000), economicEntry(SEAT, 2_000)],
    );
    expect(() => pocketBalance([result], SEAT)).toThrow(
      /duplicate economic entries/,
    );
    expect(() => winLossRecord([result], SEAT)).toThrow(
      /duplicate economic entries/,
    );
  });

  it("rejects non-finite realized profit", () => {
    for (const bad of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(() =>
        pocketBalance([matchWithProfit(SEAT, bad)], SEAT),
      ).toThrow(/realizedProfit/);
      expect(() =>
        winLossRecord([matchWithProfit(SEAT, bad)], SEAT),
      ).toThrow(/realizedProfit/);
    }
  });

  it("rejects pocket-balance overflow from finite realized profits", () => {
    const results = [
      matchWithProfit(SEAT, Number.MAX_VALUE),
      matchWithProfit(SEAT, Number.MAX_VALUE),
    ];
    expect(() => pocketBalance(results, SEAT)).toThrow(/pocket balance/);
  });
});

// ---------------------------------------------------------------------------
// Non-mutation of inputs
// ---------------------------------------------------------------------------

describe("input non-mutation", () => {
  it("pocketBalance and winLossRecord do not mutate the array or its results", () => {
    const results = [
      matchWithProfit(SEAT, 500_000),
      matchWithProfit(SEAT, -100_000),
      matchWithProfit(SEAT, 0),
    ];
    const snapshot = structuredClone(results);
    pocketBalance(results, SEAT);
    winLossRecord(results, SEAT);
    expect(results).toEqual(snapshot);
  });
});
