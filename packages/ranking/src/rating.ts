import type { MatchResult, SeatId, TrainingUtilityEntry } from "@qiju/game-core";

/**
 * Appraiser Rating — pure deterministic rating over game-core match results.
 *
 * There is no database, server, network, UI, or filesystem I/O in this
 * module. Presentation/persistence rounding and rating clamping are
 * deliberately out of scope: full numeric precision is preserved.
 */

/** Every participant starts at this rating. */
export const INITIAL_RATING = 1000;

/** Learning rate while a participant is provisional (first 20 matches). */
export const PROVISIONAL_K = 32;

/** Learning rate once a participant is established (from match 21 onward). */
export const ESTABLISHED_K = 16;

/** Number of completed matches that keep a participant provisional. */
export const PROVISIONAL_MATCH_COUNT = 20;

export interface RatingState {
  rating: number;
  completedMatches: number;
}

export const initialRatingState = (): RatingState => ({
  rating: INITIAL_RATING,
  completedMatches: 0,
});

/**
 * K is selected from the pre-update completed-match count: matches 1..20
 * (pre-update count 0..19) use the provisional K; match 21 onward
 * (pre-update count >= 20) uses the established K.
 */
export function ratingK(completedMatchesBeforeUpdate: number): number {
  return completedMatchesBeforeUpdate >= PROVISIONAL_MATCH_COUNT
    ? ESTABLISHED_K
    : PROVISIONAL_K;
}

/**
 * Relative utility of a match performance:
 * utilityNumerator / utilityDenominator, the same term game-core emits in
 * TrainingUtilityEntry (4 * finalWealth - sumW over 4 * startingBudget).
 * Typically in (-1, +1); 0 is break-even. A zero denominator yields 0.
 */
export function utilityOf(entry: TrainingUtilityEntry): number {
  if (entry.utilityDenominator === 0) return 0;
  return entry.utilityNumerator / entry.utilityDenominator;
}

/**
 * nextRating = currentRating + K * utility.
 * K is provisional or established per ratingK(). No rounding, no clamping.
 */
export function nextRating(
  currentRating: number,
  completedMatchesBeforeUpdate: number,
  utility: number,
): number {
  return currentRating + ratingK(completedMatchesBeforeUpdate) * utility;
}

/** Apply one match performance to a rating state. */
export function applyUtility(state: RatingState, utility: number): RatingState {
  return {
    rating: nextRating(state.rating, state.completedMatches, utility),
    completedMatches: state.completedMatches + 1,
  };
}

/** Apply a sequence of match utilities in order. */
export function applyUtilities(
  utilities: readonly number[],
  state: RatingState = initialRatingState(),
): RatingState {
  let current = state;
  for (const utility of utilities) {
    current = applyUtility(current, utility);
  }
  return current;
}

/**
 * Extract the utility of one seat from a completed game-core MatchResult and
 * apply it. The same function and data shape serve human and AI seats — this
 * module has no participant-type concept and never branches on one.
 */
export function applyMatchResult(
  state: RatingState,
  result: MatchResult,
  seatId: SeatId,
): RatingState {
  const entry = result.training.find(
    (e: TrainingUtilityEntry) => e.seatId === seatId,
  );
  if (!entry) {
    throw new Error(`seat ${seatId} has no training utility entry`);
  }
  return applyUtility(state, utilityOf(entry));
}

/**
 * Tycoon Ladder — cumulative realized net profit mapped to one of four
 * tiers. Thresholds in dollars.
 */
export const TYCOON_THRESHOLDS = {
  savvyAppraiser: 1_000_000,
  masterDealer: 5_000_000,
  grandAuctioneer: 20_000_000,
} as const;

export type TycoonTier =
  | "Novice Bidder"
  | "Savvy Appraiser"
  | "Master Dealer"
  | "Grand Auctioneer";

/**
 * Novice Bidder:      cumulativeProfit <  $1,000,000 (including zero/losses)
 * Savvy Appraiser:    >= $1,000,000  and <  $5,000,000
 * Master Dealer:      >= $5,000,000  and < $20,000,000
 * Grand Auctioneer:   >= $20,000,000
 */
export function tycoonTier(cumulativeRealizedNetProfit: number): TycoonTier {
  if (cumulativeRealizedNetProfit >= TYCOON_THRESHOLDS.grandAuctioneer) {
    return "Grand Auctioneer";
  }
  if (cumulativeRealizedNetProfit >= TYCOON_THRESHOLDS.masterDealer) {
    return "Master Dealer";
  }
  if (cumulativeRealizedNetProfit >= TYCOON_THRESHOLDS.savvyAppraiser) {
    return "Savvy Appraiser";
  }
  return "Novice Bidder";
}
