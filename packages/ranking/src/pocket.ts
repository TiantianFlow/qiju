import type { MatchResult, SeatId } from "@qiju/game-core";
import { exactlyOne, requireFinite } from "./validate.js";

/**
 * Pocket scoring — a single per-player ledger over game-core match results.
 *
 * There is no database, server, network, UI, or filesystem I/O in this
 * module. Presentation/persistence rounding is deliberately out of scope:
 * full numeric precision is preserved.
 *
 * MatchResult carries no participant/controller/mode field, so this module
 * has no human-vs-AI concept: the exported API accepts only economic match
 * data and seat identity.
 *
 * The engine normally supplies valid results; the boundary checks below keep
 * this standalone package deterministic when fed arbitrary data. Realized-
 * profit lookup stays module-internal so callers cannot bypass the
 * MatchResult validation path.
 */

/**
 * One table stake at content.synthetic.v2. A player with no matches has
 * exactly this.
 *
 * Deliberately a fixed constant, not read from the rule bundle at runtime:
 * a content-bundle swap must never silently restate every player's balance.
 */
export const POCKET_OPENING_BALANCE = 2_000_000;

export interface WinLossRecord {
  wins: number;
  losses: number;
  pushes: number;
}

function realizedProfitForSeat(result: MatchResult, seatId: SeatId): number {
  const entry = exactlyOne(
    result.economic,
    seatId,
    (e) => e.seatId === seatId,
    "economic",
  );
  return requireFinite(
    entry.realizedProfit,
    `realizedProfit for seat ${seatId}`,
  );
}

/**
 * POCKET_OPENING_BALANCE + sum of the seat's realizedProfit across results.
 * Requires exactly one economic entry for the seat per match. Inputs are
 * never mutated.
 */
export function pocketBalance(
  results: readonly MatchResult[],
  seatId: SeatId,
): number {
  let total = POCKET_OPENING_BALANCE;
  for (const result of results) {
    total += realizedProfitForSeat(result, seatId);
    requireFinite(total, `pocket balance for seat ${seatId}`);
  }
  return total;
}

/**
 * wins = realizedProfit > 0, losses = < 0, pushes = exactly 0.
 * Pushes are counted separately and never folded into losses. Requires
 * exactly one economic entry for the seat per match. Inputs are never
 * mutated.
 */
export function winLossRecord(
  results: readonly MatchResult[],
  seatId: SeatId,
): WinLossRecord {
  let wins = 0;
  let losses = 0;
  let pushes = 0;
  for (const result of results) {
    const profit = realizedProfitForSeat(result, seatId);
    if (profit > 0) {
      wins += 1;
    } else if (profit < 0) {
      losses += 1;
    } else {
      pushes += 1;
    }
  }
  return { wins, losses, pushes };
}
