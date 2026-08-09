import { describe, expect, it } from "vitest";
import type {
  EconomicResultEntry,
  MatchResult,
  SeatId,
  TrainingUtilityEntry,
} from "@qiju/game-core";
import {
  ESTABLISHED_K,
  INITIAL_RATING,
  PROVISIONAL_K,
  TYCOON_THRESHOLDS,
  cumulativeRealizedProfit,
  tycoonTier,
  updateAppraiserRating,
} from "./index.js";

// ---------------------------------------------------------------------------
// MatchResult builders — every rating path below goes through real
// engine-shaped MatchResult data, never raw utility number arrays.
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

/** A completed match in which `seatId` produced exactly `utility`. */
function matchWithUtility(seatId: SeatId, utility: number): MatchResult {
  return matchResult([
    trainingEntry(seatId, utility * DEFAULT_DENOMINATOR),
  ]);
}

/** A completed match in which `seatId` realized exactly `profit`. */
function matchWithProfit(seatId: SeatId, profit: number): MatchResult {
  return matchResult(
    [trainingEntry(seatId, 0)],
    [economicEntry(seatId, profit)],
  );
}

/** Fold updateAppraiserRating over real MatchResult fixtures. */
function applyMatchResults(
  results: readonly MatchResult[],
  seatId: SeatId,
  startRating: number,
  startCompleted: number,
): number {
  let rating = startRating;
  let completed = startCompleted;
  for (const result of results) {
    rating = updateAppraiserRating(rating, completed, result, seatId);
    completed += 1;
  }
  return rating;
}

const SEAT: SeatId = "seat1";
const OTHER_SEAT: SeatId = "seat2";

// ---------------------------------------------------------------------------
// Appraiser Rating — deterministic utility updates (gate 1)
// ---------------------------------------------------------------------------

describe("Appraiser Rating utility updates", () => {
  it("starts from the initial rating constant of 1000", () => {
    expect(INITIAL_RATING).toBe(1000);
  });

  it("positive utility raises the rating by K * utility", () => {
    // First match: provisional K = 32, utility +0.25.
    expect(
      updateAppraiserRating(1000, 0, matchWithUtility(SEAT, 0.25), SEAT),
    ).toBe(1000 + 32 * 0.25);
  });

  it("zero utility (break-even match) leaves the rating unchanged", () => {
    expect(
      updateAppraiserRating(1000, 0, matchWithUtility(SEAT, 0), SEAT),
    ).toBe(1000);
    expect(
      updateAppraiserRating(1234.5, 25, matchWithUtility(SEAT, 0), SEAT),
    ).toBe(1234.5);
  });

  it("negative utility (a losing match) lowers the rating by K * |utility|", () => {
    expect(
      updateAppraiserRating(1000, 0, matchWithUtility(SEAT, -0.5), SEAT),
    ).toBe(1000 - 16);
    expect(
      updateAppraiserRating(1200, 20, matchWithUtility(SEAT, -0.25), SEAT),
    ).toBe(1200 - 4);
  });

  it("preserves full numeric precision (no rounding, no clamping)", () => {
    const utility = 1 / 3;
    const rating = updateAppraiserRating(
      1000,
      0,
      matchWithUtility(SEAT, utility),
      SEAT,
    );
    expect(rating).toBe(1000 + 32 * utility);
    expect(rating).not.toBe(Math.round(rating));
  });
});

// ---------------------------------------------------------------------------
// Provisional vs established K boundary (gate 2)
// ---------------------------------------------------------------------------

describe("provisional/established K boundary", () => {
  it("match 20 (pre-update count 19) still uses the provisional rule K=32", () => {
    expect(PROVISIONAL_K).toBe(32);
    expect(
      updateAppraiserRating(1000, 19, matchWithUtility(SEAT, 0.25), SEAT),
    ).toBe(1000 + 32 * 0.25);
  });

  it("match 21 (pre-update count 20) uses the established rule K=16", () => {
    expect(ESTABLISHED_K).toBe(16);
    expect(
      updateAppraiserRating(1000, 20, matchWithUtility(SEAT, 0.25), SEAT),
    ).toBe(1000 + 16 * 0.25);
  });

  it("a 21-match window switches K exactly after the 20th match", () => {
    const results = Array.from({ length: 21 }, () =>
      matchWithUtility(SEAT, 0.5),
    );
    const rating = applyMatchResults(results, SEAT, 1000, 0);
    // 20 provisional steps of 32 * 0.5, then 1 established step of 16 * 0.5.
    expect(rating).toBe(1000 + 20 * 16 + 1 * 8);
  });
});

// ---------------------------------------------------------------------------
// Bounded bot-farm fixture (gate 3)
//
// GAME FRAMING — this is the property that made us reject Elo, not a test of
// addition:
//
//   * thin-farm player: WON ALL 20 matches, each by a hair (utility +0.01).
//   * wide-result player: WON EXACTLY 1 match decisively (utility +0.25) and
//     was neutral in the other 19 (utility 0).
//
// A win-count system (Elo) would rank the 20-0 player far above the 1-0-19
// player. The Appraiser Rating is margin-proportional and blind to win
// count, so the single wide win must finish higher than twenty thin wins
// inside an equal 20-match window from the same starting rating/status.
//
// Every match below is a real MatchResult carrying the game-core
// numerator/denominator pair; no raw-utility number helper is exported.
// ---------------------------------------------------------------------------

function thinFarmWindow(seatId: SeatId): MatchResult[] {
  // The thin-farm player WON ALL 20 matches by a hair.
  return Array.from({ length: 20 }, () => matchWithUtility(seatId, 0.01));
}

function wideResultWindow(seatId: SeatId): MatchResult[] {
  // The wide-result player WON EXACTLY 1 match decisively, neutral in 19.
  return [
    matchWithUtility(seatId, 0.25),
    ...Array.from({ length: 19 }, () => matchWithUtility(seatId, 0)),
  ];
}

describe("bot-farm fixture: margin-proportional rating is blind to win count", () => {
  it("provisional window: 20 thin wins (+0.01 x20) finish below 1 wide win (+0.25) plus 19 neutral matches", () => {
    const thin = applyMatchResults(thinFarmWindow(SEAT), SEAT, 1000, 0);
    const wide = applyMatchResults(wideResultWindow(SEAT), SEAT, 1000, 0);
    expect(wide).toBeGreaterThan(thin);
    // Exact unrounded values in the accumulation order the function uses:
    // 20 sequential provisional steps of 32 * 0.01 vs one step of 32 * 0.25.
    expect(thin).toBe(
      Array<number>(20)
        .fill(0.01)
        .reduce((r, u) => r + PROVISIONAL_K * u, INITIAL_RATING),
    );
    expect(wide).toBe(1000 + 32 * 0.25);
  });

  it("established window: 20 thin wins finish below 1 wide win plus 19 neutral matches under K=16", () => {
    // Same 20-match window, both players already established
    // (20 completed matches before the window starts).
    const thin = applyMatchResults(thinFarmWindow(SEAT), SEAT, 1000, 20);
    const wide = applyMatchResults(wideResultWindow(SEAT), SEAT, 1000, 20);
    expect(wide).toBeGreaterThan(thin);
    // Exact unrounded values: 20 sequential established steps of 16 * 0.01
    // vs one step of 16 * 0.25.
    expect(thin).toBe(
      Array<number>(20)
        .fill(0.01)
        .reduce((r, u) => r + ESTABLISHED_K * u, INITIAL_RATING),
    );
    expect(wide).toBe(1000 + 16 * 0.25);
  });
});

// ---------------------------------------------------------------------------
// Boundary validation: rating inputs (gates 3/6)
// ---------------------------------------------------------------------------

describe("rating input validation", () => {
  const good = matchWithUtility(SEAT, 0.25);

  it("rejects non-finite currentRating", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => updateAppraiserRating(bad, 0, good, SEAT)).toThrow(
        /currentRating/,
      );
    }
  });

  it("rejects non-finite, negative, and fractional completed-match counts", () => {
    for (const bad of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => updateAppraiserRating(1000, bad, good, SEAT)).toThrow(
        /completedMatchesBeforeUpdate/,
      );
    }
  });

  it("rejects a missing training entry for the seat", () => {
    const result = matchResult([trainingEntry(OTHER_SEAT, 100)]);
    expect(() => updateAppraiserRating(1000, 0, result, SEAT)).toThrow(
      /no training utility entry/,
    );
  });

  it("rejects duplicate training entries for the seat", () => {
    const result = matchResult([
      trainingEntry(SEAT, 100),
      trainingEntry(SEAT, 200),
    ]);
    expect(() => updateAppraiserRating(1000, 0, result, SEAT)).toThrow(
      /duplicate training utility entries/,
    );
  });

  it("rejects non-finite numerator and denominator", () => {
    expect(() =>
      updateAppraiserRating(
        1000,
        0,
        matchResult([trainingEntry(SEAT, Number.NaN)]),
        SEAT,
      ),
    ).toThrow(/utilityNumerator/);
    expect(() =>
      updateAppraiserRating(
        1000,
        0,
        matchResult([trainingEntry(SEAT, 100, Number.POSITIVE_INFINITY)]),
        SEAT,
      ),
    ).toThrow(/utilityDenominator/);
  });

  it("rejects zero or negative denominators instead of converting to neutral", () => {
    for (const bad of [0, -400_000]) {
      expect(() =>
        updateAppraiserRating(
          1000,
          0,
          matchResult([trainingEntry(SEAT, 100, bad)]),
          SEAT,
        ),
      ).toThrow(/utilityDenominator.*positive/);
    }
  });

  it("rejects a completed count beyond the safe-integer range", () => {
    expect(() =>
      updateAppraiserRating(
        1000,
        Number.MAX_SAFE_INTEGER + 1,
        matchWithUtility(SEAT, 0.25),
        SEAT,
      ),
    ).toThrow(/completedMatchesBeforeUpdate.*safe integer/);
  });

  it("rejects utility overflow from finite numerator and denominator", () => {
    const result = matchResult([
      trainingEntry(SEAT, Number.MAX_VALUE, Number.MIN_VALUE),
    ]);
    expect(() => updateAppraiserRating(1000, 0, result, SEAT)).toThrow(
      /computed utility/,
    );
  });

  it("rejects updated-rating overflow from finite operands", () => {
    const result = matchResult([trainingEntry(SEAT, Number.MAX_VALUE, 1)]);
    expect(() => updateAppraiserRating(1000, 0, result, SEAT)).toThrow(
      /computed updated rating/,
    );
    expect(() => updateAppraiserRating(1000, 20, result, SEAT)).toThrow(
      /computed updated rating/,
    );
  });
});

// ---------------------------------------------------------------------------
// Cumulative realized profit (gate 6)
// ---------------------------------------------------------------------------

describe("cumulativeRealizedProfit", () => {
  it("sums realized profit across matches for the selected seat only", () => {
    const results = [
      matchResult(
        [trainingEntry(SEAT, 0), trainingEntry(OTHER_SEAT, 0)],
        [economicEntry(SEAT, 500_000), economicEntry(OTHER_SEAT, 9_999_999)],
      ),
      matchResult(
        [trainingEntry(SEAT, 0), trainingEntry(OTHER_SEAT, 0)],
        [economicEntry(SEAT, 750_000), economicEntry(OTHER_SEAT, 1)],
      ),
    ];
    expect(cumulativeRealizedProfit(results, SEAT)).toBe(1_250_000);
    // The other seat's profits are never added in.
    expect(cumulativeRealizedProfit(results, OTHER_SEAT)).toBe(10_000_000);
  });

  it("empty history and zero-profit no-sale matches count as zero", () => {
    expect(cumulativeRealizedProfit([], SEAT)).toBe(0);
    const noSale = matchWithProfit(SEAT, 0);
    expect(cumulativeRealizedProfit([noSale, noSale], SEAT)).toBe(0);
  });

  it("accumulates net losses as negative profit", () => {
    const results = [
      matchWithProfit(SEAT, 600_000),
      matchWithProfit(SEAT, -250_000),
      matchWithProfit(SEAT, -500_000),
    ];
    expect(cumulativeRealizedProfit(results, SEAT)).toBe(-150_000);
    expect(tycoonTier(cumulativeRealizedProfit(results, SEAT))).toBe(
      "Novice Bidder",
    );
  });

  it("rejects a missing economic entry for the seat", () => {
    const result = matchResult(
      [trainingEntry(SEAT, 0)],
      [economicEntry(OTHER_SEAT, 1_000)],
    );
    expect(() => cumulativeRealizedProfit([result], SEAT)).toThrow(
      /no economic entry/,
    );
  });

  it("rejects duplicate economic entries for the seat", () => {
    const result = matchResult(
      [trainingEntry(SEAT, 0)],
      [economicEntry(SEAT, 1_000), economicEntry(SEAT, 2_000)],
    );
    expect(() => cumulativeRealizedProfit([result], SEAT)).toThrow(
      /duplicate economic entries/,
    );
  });

  it("rejects non-finite realized profit", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() =>
        cumulativeRealizedProfit([matchWithProfit(SEAT, bad)], SEAT),
      ).toThrow(/realizedProfit/);
    }
  });

  it("rejects cumulative overflow from finite realized profits", () => {
    const results = [
      matchWithProfit(SEAT, Number.MAX_VALUE),
      matchWithProfit(SEAT, Number.MAX_VALUE),
    ];
    expect(() => cumulativeRealizedProfit(results, SEAT)).toThrow(
      /cumulative realized profit/,
    );
  });
});

// ---------------------------------------------------------------------------
// Non-mutation of inputs (gate 6)
// ---------------------------------------------------------------------------

describe("input non-mutation", () => {
  it("updateAppraiserRating does not mutate the MatchResult", () => {
    const result = matchWithUtility(SEAT, 0.25);
    const snapshot = structuredClone(result);
    updateAppraiserRating(1000, 0, result, SEAT);
    expect(result).toEqual(snapshot);
  });

  it("cumulativeRealizedProfit does not mutate the array or its results", () => {
    const results = [
      matchWithProfit(SEAT, 500_000),
      matchWithProfit(SEAT, -100_000),
    ];
    const snapshot = structuredClone(results);
    cumulativeRealizedProfit(results, SEAT);
    expect(results).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// Structural mode-independence (gate 5)
//
// MatchResult has no participant/controller/mode field and the exported API
// accepts only economic match data plus a SeatId. Identical economic data for
// two seats therefore produces identical updates, whichever side of the table
// is human or AI — there is no participant-type code path to branch on.
// ---------------------------------------------------------------------------

describe("structural mode-independence: identical economics, identical rating", () => {
  it("two seats with identical training entries get identical updates", () => {
    const result = matchResult([
      trainingEntry("seat1", 100_000),
      trainingEntry("seat2", 100_000),
      trainingEntry("seat3", -50_000),
      trainingEntry("seat4", 0),
    ]);
    expect(updateAppraiserRating(1000, 0, result, "seat1")).toBe(
      updateAppraiserRating(1000, 0, result, "seat2"),
    );
    expect(updateAppraiserRating(1000, 0, result, "seat1")).toBe(
      1000 + 32 * (100_000 / DEFAULT_DENOMINATOR),
    );
    expect(updateAppraiserRating(1000, 0, result, "seat4")).toBe(1000);
    expect(updateAppraiserRating(1000, 0, result, "seat3")).toBe(
      1000 + 32 * (-50_000 / DEFAULT_DENOMINATOR),
    );
  });
});

// ---------------------------------------------------------------------------
// Tycoon Ladder (gate 4)
// ---------------------------------------------------------------------------

describe("Tycoon Ladder tier mapping", () => {
  const { savvyAppraiser, masterDealer, grandAuctioneer } = TYCOON_THRESHOLDS;

  it("zero and net losses are Novice Bidder", () => {
    expect(tycoonTier(0)).toBe("Novice Bidder");
    expect(tycoonTier(-1)).toBe("Novice Bidder");
    expect(tycoonTier(-5_000_000)).toBe("Novice Bidder");
  });

  it("$1,000,000 boundary: below / at / above", () => {
    expect(tycoonTier(savvyAppraiser - 1)).toBe("Novice Bidder");
    expect(tycoonTier(savvyAppraiser)).toBe("Savvy Appraiser");
    expect(tycoonTier(savvyAppraiser + 1)).toBe("Savvy Appraiser");
  });

  it("$5,000,000 boundary: below / at / above", () => {
    expect(tycoonTier(masterDealer - 1)).toBe("Savvy Appraiser");
    expect(tycoonTier(masterDealer)).toBe("Master Dealer");
    expect(tycoonTier(masterDealer + 1)).toBe("Master Dealer");
  });

  it("$20,000,000 boundary: below / at / above", () => {
    expect(tycoonTier(grandAuctioneer - 1)).toBe("Master Dealer");
    expect(tycoonTier(grandAuctioneer)).toBe("Grand Auctioneer");
    expect(tycoonTier(grandAuctioneer + 1)).toBe("Grand Auctioneer");
  });

  it("rejects non-finite cumulative profit", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => tycoonTier(bad)).toThrow(/cumulativeRealizedNetProfit/);
    }
  });

  it("maps engine-summed profit to a tier", () => {
    const results = [
      matchWithProfit(SEAT, 4_000_000),
      matchWithProfit(SEAT, 1_500_000),
    ];
    expect(tycoonTier(cumulativeRealizedProfit(results, SEAT))).toBe(
      "Master Dealer",
    );
  });
});
