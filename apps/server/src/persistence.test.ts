import { describe, expect, it, vi } from "vitest";
import {
  buildPersistedMatch,
  persistMatchCompletionFailOpen,
  ZERO_CAREER,
  type MatchPersistenceStore,
  type PersistedMatchInput,
} from "./persistence.js";
import type { MatchResult } from "@qiju/game-core";

/**
 * THE-37b unit tests — no Supabase, no network. The real store's SQL is
 * covered by persistence.integration.test.ts under test:integration; here
 * we prove the pure mapping and the fail-open completion boundary.
 */

const RESULT: MatchResult = {
  acquisition: { buyerSeatId: "seat2", winningBid: 4000, settlementRound: 3 },
  economic: [
    { seatId: "seat1", finalWealth: 9000, realizedProfit: -1000, bonusReward: 0, denseEconomicRank: 3 },
    { seatId: "seat2", finalWealth: 14000, realizedProfit: 4000, bonusReward: 500, denseEconomicRank: 1 },
    { seatId: "seat3", finalWealth: 8000, realizedProfit: -2000, bonusReward: 0, denseEconomicRank: 4 },
    { seatId: "seat4", finalWealth: 11000, realizedProfit: 1000, bonusReward: 250, denseEconomicRank: 2 },
  ],
  training: [
    { seatId: "seat1", utilityNumerator: -6000, utilityDenominator: 40000 },
    { seatId: "seat2", utilityNumerator: 16000, utilityDenominator: 40000 },
    { seatId: "seat3", utilityNumerator: -8000, utilityDenominator: 40000 },
    { seatId: "seat4", utilityNumerator: 4000, utilityDenominator: 40000 },
  ],
};

describe("buildPersistedMatch", () => {
  it("carries the raw settlement fields per seat, human seat attributed, agents null", () => {
    const input = buildPersistedMatch({
      matchId: "seed-abc",
      mode: "human-vs-ai",
      seed: "s1",
      ruleBundleId: "bundle.v2",
      ruleManifestHash: "mh",
      contentHash: "ch",
      finalStateHash: "fsh",
      result: RESULT,
      seats: [
        { seatId: "seat1", kind: "human", principalId: "user-uuid-1" },
        { seatId: "seat2", kind: "agent" },
        { seatId: "seat3", kind: "agent" },
        { seatId: "seat4", kind: "agent" },
      ],
    });
    expect(input.matchId).toBe("seed-abc");
    expect(input.mode).toBe("human-vs-ai");
    expect(input.seats).toHaveLength(4);
    expect(input.seats[0]).toMatchObject({
      seatId: "seat1",
      controllerKind: "human",
      userId: "user-uuid-1",
      finalWealth: 9000,
      realizedProfit: -1000,
      bonusReward: 0,
      denseEconomicRank: 3,
      utilityNumerator: -6000,
      utilityDenominator: 40000,
    });
    // Agents: no user attribution — the nullable user reference is what
    // keeps all-ai economics out of career aggregates in SQL.
    for (const seat of input.seats.slice(1)) {
      expect(seat.controllerKind).toBe("agent");
      expect(seat.userId).toBeNull();
    }
  });

  it("an all-ai match attributes no economic result to any user", () => {
    const input = buildPersistedMatch({
      matchId: "seed-ai",
      mode: "all-ai",
      seed: "s2",
      ruleBundleId: "bundle.v2",
      ruleManifestHash: "mh",
      contentHash: "ch",
      finalStateHash: "fsh",
      result: RESULT,
      seats: [
        { seatId: "seat1", kind: "agent" },
        { seatId: "seat2", kind: "agent" },
        { seatId: "seat3", kind: "agent" },
        { seatId: "seat4", kind: "agent" },
      ],
    });
    expect(input.mode).toBe("all-ai");
    expect(input.seats.every((s) => s.userId === null)).toBe(true);
    expect(input.seats.every((s) => s.controllerKind === "agent")).toBe(true);
  });

  it("throws when the settlement is missing a seat (defensive; engine guarantees coverage)", () => {
    expect(() =>
      buildPersistedMatch({
        matchId: "m",
        mode: "all-ai",
        seed: "s",
        ruleBundleId: "b",
        ruleManifestHash: "mh",
        contentHash: "ch",
        finalStateHash: "fsh",
        result: { ...RESULT, economic: RESULT.economic.slice(0, 3) },
        seats: [
          { seatId: "seat1", kind: "agent" },
          { seatId: "seat2", kind: "agent" },
          { seatId: "seat3", kind: "agent" },
          { seatId: "seat4", kind: "agent" },
        ],
      }),
    ).toThrow(/settlement missing/);
  });
});

describe("fail-open completion boundary", () => {
  const INPUT: PersistedMatchInput = buildPersistedMatch({
    matchId: "seed-x",
    mode: "all-ai",
    seed: "s",
    ruleBundleId: "b",
    ruleManifestHash: "mh",
    contentHash: "ch",
    finalStateHash: "fsh",
    result: RESULT,
    seats: [
      { seatId: "seat1", kind: "agent" },
      { seatId: "seat2", kind: "agent" },
      { seatId: "seat3", kind: "agent" },
      { seatId: "seat4", kind: "agent" },
    ],
  });

  it("a store rejection is logged and swallowed — never thrown, never rejected", async () => {
    const store: MatchPersistenceStore = {
      insertMatch: async () => {
        throw new Error("simulated database failure");
      },
      careerForUser: async () => ({ ...ZERO_CAREER }),
    };
    const logError = vi.fn();
    // Must not throw synchronously…
    expect(() => persistMatchCompletionFailOpen(store, INPUT, logError)).not.toThrow();
    // …and the async rejection must be converted into a log line, not a crash.
    await new Promise((resolve) => setImmediate(resolve));
    expect(logError).toHaveBeenCalledWith("simulated database failure");
  });

  it("a synchronous store throw is contained as an async rejection (still swallowed)", async () => {
    const store: MatchPersistenceStore = {
      insertMatch: () => {
        throw new Error("sync blowup");
      },
      careerForUser: async () => ({ ...ZERO_CAREER }),
    };
    const logError = vi.fn();
    expect(() => persistMatchCompletionFailOpen(store, INPUT, logError)).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    expect(logError).toHaveBeenCalledWith("sync blowup");
  });

  it("a successful store logs nothing", async () => {
    const calls: PersistedMatchInput[] = [];
    const store: MatchPersistenceStore = {
      insertMatch: async (input) => {
        calls.push(input);
      },
      careerForUser: async () => ({ ...ZERO_CAREER }),
    };
    const logError = vi.fn();
    persistMatchCompletionFailOpen(store, INPUT, logError);
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toHaveLength(1);
    expect(logError).not.toHaveBeenCalled();
  });
});
