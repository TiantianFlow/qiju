import type { CompiledRuleRuntime, MatchState, PublicView, SeatId } from "@qiju/game-core";
import {
  cellFloor as coreCellFloor,
  estimateConservativeValue as coreEstimate,
  observePublic,
  observeSeat,
  tierFloor as coreTierFloor,
} from "@qiju/game-core";

export const tierFloor = coreTierFloor;
export const cellFloor = coreCellFloor;

/** Re-export / wrapper used by session-runtime tests and demo tooling. */
export function estimateConservativeValue(
  runtime: CompiledRuleRuntime,
  state: MatchState,
  knowledge?: Map<string, Partial<Record<string, unknown>>>,
): number {
  if (knowledge) {
    return coreEstimate(runtime, state, knowledge as never);
  }
  return observePublic(runtime, state).estimatedValue;
}

/** Public-frame estimate must never use completed-only identity dump before completed. */
export function estimatedValueForView(view: PublicView): number {
  return view.estimatedValue;
}

export function estimateForSeat(
  runtime: CompiledRuleRuntime,
  state: MatchState,
  seatId: SeatId,
): number {
  return observeSeat(runtime, state, seatId).estimatedValue;
}
