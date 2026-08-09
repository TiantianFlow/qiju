import type { MatchResult, SeatId } from "@qiju/game-core";

/**
 * Appraiser Rating and Tycoon Ladder — pure deterministic ranking over
 * game-core match results.
 *
 * There is no database, server, network, UI, or filesystem I/O in this
 * module. Presentation/persistence rounding and rating clamping are
 * deliberately out of scope: full numeric precision is preserved.
 *
 * MatchResult carries no participant/controller/mode field, so this module
 * has no human-vs-AI concept: the exported API accepts only economic match
 * data and seat identity.
 *
 * The engine normally supplies valid results; the boundary checks below keep
 * this standalone package deterministic when fed arbitrary data. Raw-utility
 * accumulation helpers stay module-internal so callers cannot bypass the
 * MatchResult validation path.
 */

/** Every participant starts at this rating. */
export const INITIAL_RATING = 1000;

/** Learning rate while a participant is provisional (first 20 matches). */
export const PROVISIONAL_K = 32;

/** Learning rate once a participant is established (from match 21 onward). */
export const ESTABLISHED_K = 16;

/** Number of completed matches that keep a participant provisional. */
export const PROVISIONAL_MATCH_COUNT = 20;

export type TycoonTier =
  | "Novice Bidder"
  | "Savvy Appraiser"
  | "Master Dealer"
  | "Grand Auctioneer";

/** Tycoon Ladder thresholds in dollars. */
export const TYCOON_THRESHOLDS = {
  savvyAppraiser: 1_000_000,
  masterDealer: 5_000_000,
  grandAuctioneer: 20_000_000,
} as const;

function requireFinite(value: number, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${what} must be a finite number, got ${String(value)}`);
  }
  return value;
}

function requireCompletedCount(completedMatchesBeforeUpdate: number): number {
  requireFinite(completedMatchesBeforeUpdate, "completedMatchesBeforeUpdate");
  if (
    !Number.isSafeInteger(completedMatchesBeforeUpdate) ||
    completedMatchesBeforeUpdate < 0
  ) {
    throw new Error(
      `completedMatchesBeforeUpdate must be a non-negative safe integer, got ${String(
        completedMatchesBeforeUpdate,
      )}`,
    );
  }
  return completedMatchesBeforeUpdate;
}

/** Exactly one matching entry is required: zero or two-plus is an error. */
function exactlyOne<T>(
  entries: readonly T[],
  seatId: SeatId,
  matches: (entry: T) => boolean,
  list: string,
): T {
  const found = entries.filter(matches);
  if (found.length === 0) {
    throw new Error(`seat ${seatId} has no ${list} entry in match result`);
  }
  if (found.length > 1) {
    throw new Error(
      `seat ${seatId} has ${found.length} duplicate ${list} entries in match result`,
    );
  }
  const entry = found[0];
  if (entry === undefined) {
    throw new Error(`seat ${seatId} has no ${list} entry in match result`);
  }
  return entry;
}

/**
 * Relative utility of the seat's match performance:
 * utilityNumerator / utilityDenominator, the same term game-core emits in
 * TrainingUtilityEntry (4 * finalWealth - sumW over 4 * startingBudget).
 * Typically in (-1, +1); 0 is break-even. A non-positive denominator is a
 * malformed engine result and is rejected, not converted to neutral.
 */
function validatedUtility(result: MatchResult, seatId: SeatId): number {
  const entry = exactlyOne(
    result.training,
    seatId,
    (e) => e.seatId === seatId,
    "training utility",
  );
  const numerator = requireFinite(
    entry.utilityNumerator,
    `utilityNumerator for seat ${seatId}`,
  );
  const denominator = requireFinite(
    entry.utilityDenominator,
    `utilityDenominator for seat ${seatId}`,
  );
  if (denominator <= 0) {
    throw new Error(
      `utilityDenominator for seat ${seatId} must be positive, got ${String(
        denominator,
      )}`,
    );
  }
  return requireFinite(
    numerator / denominator,
    `computed utility for seat ${seatId}`,
  );
}

/**
 * nextRating = currentRating + K * utility.
 * K is selected from the pre-update completed-match count: matches 1..20
 * (pre-update count 0..19) use the provisional K; match 21 onward
 * (pre-update count >= 20) uses the established K.
 * No rounding, no clamping.
 */
function nextRating(
  currentRating: number,
  completedMatchesBeforeUpdate: number,
  utility: number,
): number {
  const k =
    completedMatchesBeforeUpdate >= PROVISIONAL_MATCH_COUNT
      ? ESTABLISHED_K
      : PROVISIONAL_K;
  return requireFinite(
    currentRating + k * utility,
    "computed updated rating",
  );
}

/**
 * Update the Appraiser Rating for one seat from one engine-produced
 * MatchResult. Requires exactly one training entry for the seat and rejects
 * non-finite or structurally invalid inputs. Inputs are never mutated.
 */
export function updateAppraiserRating(
  currentRating: number,
  completedMatchesBeforeUpdate: number,
  result: MatchResult,
  seatId: SeatId,
): number {
  requireFinite(currentRating, "currentRating");
  requireCompletedCount(completedMatchesBeforeUpdate);
  const utility = validatedUtility(result, seatId);
  return nextRating(currentRating, completedMatchesBeforeUpdate, utility);
}

/**
 * Sum the seat's realized net profit across matches. Requires exactly one
 * economic entry for the seat per match. Inputs are never mutated.
 */
export function cumulativeRealizedProfit(
  results: readonly MatchResult[],
  seatId: SeatId,
): number {
  let total = 0;
  for (const result of results) {
    const entry = exactlyOne(
      result.economic,
      seatId,
      (e) => e.seatId === seatId,
      "economic",
    );
    total += requireFinite(
      entry.realizedProfit,
      `realizedProfit for seat ${seatId}`,
    );
    requireFinite(total, `cumulative realized profit for seat ${seatId}`);
  }
  return total;
}

/**
 * Novice Bidder:      cumulativeProfit <  $1,000,000 (including zero/losses)
 * Savvy Appraiser:    >= $1,000,000  and <  $5,000,000
 * Master Dealer:      >= $5,000,000  and < $20,000,000
 * Grand Auctioneer:   >= $20,000,000
 */
export function tycoonTier(cumulativeRealizedNetProfit: number): TycoonTier {
  requireFinite(cumulativeRealizedNetProfit, "cumulativeRealizedNetProfit");
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
