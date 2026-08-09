import { describe, expect, it } from "vitest";
import type { MatchResult, SeatId, TrainingUtilityEntry } from "@qiju/game-core";
import {
  ESTABLISHED_K,
  INITIAL_RATING,
  PROVISIONAL_K,
  PROVISIONAL_MATCH_COUNT,
  TYCOON_THRESHOLDS,
  applyMatchResult,
  applyUtilities,
  applyUtility,
  initialRatingState,
  nextRating,
  ratingK,
  tycoonTier,
  utilityOf,
} from "./index.js";

// ---------------------------------------------------------------------------
// Appraiser Rating — deterministic utility updates (gate 1)
// ---------------------------------------------------------------------------

describe("Appraiser Rating utility updates", () => {
  it("starts at 1000 with zero completed matches", () => {
    expect(initialRatingState()).toEqual({
      rating: INITIAL_RATING,
      completedMatches: 0,
    });
    expect(INITIAL_RATING).toBe(1000);
  });

  it("positive utility raises the rating by K * utility", () => {
    // First match: provisional K = 32.
    expect(nextRating(1000, 0, 0.25)).toBe(1000 + 32 * 0.25);
    expect(nextRating(1000, 0, 0.25)).toBe(1008);
  });

  it("zero utility leaves the rating unchanged", () => {
    expect(nextRating(1000, 0, 0)).toBe(1000);
    expect(nextRating(1234.5, 25, 0)).toBe(1234.5);
  });

  it("negative utility lowers the rating by K * |utility|", () => {
    expect(nextRating(1000, 0, -0.5)).toBe(1000 - 16);
    // Established K applies below as well.
    expect(nextRating(1200, 20, -0.25)).toBe(1200 - 4);
  });

  it("preserves full numeric precision (no rounding, no clamping)", () => {
    const result = nextRating(1000, 0, 1 / 3);
    expect(result).toBe(1000 + 32 / 3);
    expect(result).not.toBe(Math.round(result));
  });

  it("utilityOf divides the game-core numerator by the denominator", () => {
    const entry: TrainingUtilityEntry = {
      seatId: "seat1",
      utilityNumerator: 400_000,
      utilityDenominator: 2_000_000,
    };
    expect(utilityOf(entry)).toBe(0.2);
  });

  it("utilityOf treats a zero denominator as zero utility", () => {
    const entry: TrainingUtilityEntry = {
      seatId: "seat1",
      utilityNumerator: 1,
      utilityDenominator: 0,
    };
    expect(utilityOf(entry)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Provisional vs established K boundary (gate 2)
// ---------------------------------------------------------------------------

describe("provisional/established K boundary", () => {
  it("uses provisional K=32 for pre-update counts 0..19 (matches 1..20)", () => {
    expect(ratingK(0)).toBe(PROVISIONAL_K);
    expect(ratingK(19)).toBe(PROVISIONAL_K);
    expect(PROVISIONAL_K).toBe(32);
  });

  it("match 20 (pre-update count 19) still uses the provisional rule", () => {
    // The 20th completed match: 19 matches already recorded before update.
    expect(nextRating(1000, 19, 0.25)).toBe(1000 + 32 * 0.25);
  });

  it("match 21 (pre-update count 20) uses the established rule K=16", () => {
    expect(ratingK(20)).toBe(ESTABLISHED_K);
    expect(ESTABLISHED_K).toBe(16);
    expect(nextRating(1000, 20, 0.25)).toBe(1000 + 16 * 0.25);
  });

  it("applyUtilities switches K exactly after the 20th match", () => {
    const utilities = Array<number>(21).fill(0.5);
    const state = applyUtilities(utilities);
    // 20 provisional steps of 32 * 0.5, then 1 established step of 16 * 0.5.
    expect(state.completedMatches).toBe(21);
    expect(state.rating).toBe(1000 + 20 * 16 + 1 * 8);
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
// ---------------------------------------------------------------------------

const THIN_FARM_20_WINS = Array<number>(20).fill(0.01);
const WIDE_RESULT_1_WIN = [0.25, ...Array<number>(19).fill(0)];

describe("bot-farm fixture: margin-proportional rating is blind to win count", () => {
  it("provisional window: 20 thin wins (+0.01 x20) finish below 1 wide win (+0.25) plus 19 neutral matches", () => {
    // thin-farm player: won all 20 matches by a hair.
    const thin = applyUtilities(THIN_FARM_20_WINS);
    // wide-result player: won only 1 match, neutral in 19.
    const wide = applyUtilities(WIDE_RESULT_1_WIN);
    expect(thin.completedMatches).toBe(20);
    expect(wide.completedMatches).toBe(20);
    expect(wide.rating).toBeGreaterThan(thin.rating);
    // Exact unrounded values in the accumulation order the function uses:
    // 20 sequential provisional steps of 32 * 0.01 vs one step of 32 * 0.25.
    expect(thin.rating).toBe(
      THIN_FARM_20_WINS.reduce((r, u) => r + PROVISIONAL_K * u, INITIAL_RATING),
    );
    expect(wide.rating).toBe(1000 + 32 * 0.25);
  });

  it("established window: 20 thin wins finish below 1 wide win plus 19 neutral matches under K=16", () => {
    // Same 20-match window, both players already established
    // (20 completed matches before the window starts).
    const established = {
      rating: INITIAL_RATING,
      completedMatches: PROVISIONAL_MATCH_COUNT,
    };
    const thin = applyUtilities(THIN_FARM_20_WINS, established);
    const wide = applyUtilities(WIDE_RESULT_1_WIN, established);
    expect(thin.completedMatches).toBe(40);
    expect(wide.completedMatches).toBe(40);
    expect(wide.rating).toBeGreaterThan(thin.rating);
    // Exact unrounded values: 20 sequential established steps of 16 * 0.01
    // vs one step of 16 * 0.25.
    expect(thin.rating).toBe(
      THIN_FARM_20_WINS.reduce((r, u) => r + ESTABLISHED_K * u, INITIAL_RATING),
    );
    expect(wide.rating).toBe(1000 + 16 * 0.25);
  });
});

// ---------------------------------------------------------------------------
// Human vs AI — no participant-type code path (gate 5)
// ---------------------------------------------------------------------------

describe("human and AI seats share one code path", () => {
  function completedResult(training: TrainingUtilityEntry[]): MatchResult {
    return { acquisition: {}, economic: [], training };
  }

  it("identical results for human-vs-AI and human-vs-human inputs", () => {
    // The module receives a MatchResult and a SeatId; nothing carries a
    // participant type, so the same numbers must produce the same update.
    const humanSeat: SeatId = "seat1";
    const aiSeat: SeatId = "seat2";
    const entry = (seatId: SeatId): TrainingUtilityEntry => ({
      seatId,
      utilityNumerator: 100_000,
      utilityDenominator: 400_000,
    });

    const humanVsAi = completedResult([entry(humanSeat), entry(aiSeat)]);
    const humanVsHuman = completedResult([entry(humanSeat), entry(aiSeat)]);

    const start = initialRatingState();
    expect(applyMatchResult(start, humanVsAi, humanSeat)).toEqual(
      applyMatchResult(start, humanVsHuman, humanSeat),
    );
    expect(applyMatchResult(start, humanVsAi, aiSeat)).toEqual(
      applyMatchResult(start, humanVsHuman, aiSeat),
    );
    // utility 0.25 with provisional K: 1000 + 32 * 0.25.
    expect(applyMatchResult(start, humanVsAi, humanSeat).rating).toBe(1008);
  });

  it("throws when the seat has no training entry in the match result", () => {
    const result = completedResult([]);
    expect(() =>
      applyMatchResult(initialRatingState(), result, "seat4"),
    ).toThrow(/no training utility entry/);
  });

  it("applyUtility increments the completed-match count", () => {
    const state = applyUtility(initialRatingState(), -0.1);
    expect(state.completedMatches).toBe(1);
    expect(state.rating).toBe(1000 + 32 * -0.1);
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
});
