import type { SeatId } from "@qiju/game-core";

/**
 * Shared input guards for ranking derivations.
 *
 * There is no database, server, network, UI, or filesystem I/O in this
 * module. Inputs are never mutated.
 */

export function requireFinite(value: number, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${what} must be a finite number, got ${String(value)}`);
  }
  return value;
}

/** Exactly one matching entry is required: zero or two-plus is an error. */
export function exactlyOne<T>(
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
