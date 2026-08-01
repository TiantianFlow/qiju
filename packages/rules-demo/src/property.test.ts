import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { compileDemoV0 } from "@qiju/rules-demo";
import {
  createMatch,
  transition,
  observeSeat,
  observePublic,
  hashState,
  SEAT_IDS,
  type GameCommand,
  type MatchState,
} from "@qiju/game-core";

const runtime = compileDemoV0();
const B = runtime.config.startingBudget;
const ANALYSTS = [...runtime.analysts.keys()];
const KITS = [...runtime.toolPackages.keys()];

const commandArb = (state: MatchState): fc.Arbitrary<GameCommand> => {
  const phase = state.phase.kind;
  if (phase === "setup") {
    const seat = state.seats.find((s) => !s.setupLocked) ?? state.seats[0]!;
    if (!seat.analystId) {
      return fc.record({
        kind: fc.constant("select_loadout" as const),
        seatId: fc.constant(seat.seatId),
        analystId: fc.constantFrom(...ANALYSTS),
        toolPackageId: fc.constantFrom(...KITS),
      });
    }
    return fc.constant({ kind: "lock_setup", seatId: seat.seatId });
  }
  const window = state.window;
  if (!window) return fc.constant({ kind: "deadline_reached", actionWindowId: "w-none" });
  const choices: fc.Arbitrary<GameCommand>[] = [
    fc.constant({ kind: "deadline_reached", actionWindowId: window.actionWindowId }),
  ];
  for (const participant of window.participants) {
    if (window.bids[participant]?.locked) continue;
    choices.push(
      fc.record({
        kind: fc.constant("submit_bid" as const),
        seatId: fc.constant(participant),
        amount: fc.integer({ min: 0, max: B }),
        actionWindowId: fc.constant(window.actionWindowId),
      }),
    );
    if (window.bids[participant]) {
      choices.push(
        fc.constant({
          kind: "lock_bid",
          seatId: participant,
          actionWindowId: window.actionWindowId,
        }),
      );
    }
    if (window.kind === "round" && !window.toolUsed[participant]) {
      const seat = state.seats.find((s) => s.seatId === participant);
      const pkg = seat?.toolPackageId ? runtime.toolPackages.get(seat.toolPackageId) : undefined;
      for (const tool of pkg?.tools ?? []) {
        if ((seat?.toolCharges[tool.id] ?? 0) === 0) {
          choices.push(
            fc.constant({
              kind: "use_tool",
              seatId: participant,
              toolId: tool.id,
              actionWindowId: window.actionWindowId,
            }),
          );
        }
      }
    }
  }
  return fc.oneof(...choices);
};

function checkInvariants(state: MatchState): void {
  const phase = state.phase;
  if (phase.kind === "completed") {
    const result = phase.result;
    const hasBuyer = result.acquisition.buyerSeatId !== undefined;
    const hasNoSale = result.acquisition.noSaleReason !== undefined;
    expect(hasBuyer !== hasNoSale).toBe(true);
    if (hasBuyer) {
      const P = result.acquisition.winningBid!;
      const V = state.lot!.actualValue;
      const bonus = Math.floor(Math.max(0, P - V) / 10);
      const sumW = result.economic.reduce((a, e) => a + e.finalWealth, 0);
      expect(sumW).toBe(4 * B - P + V + 3 * bonus);
      expect(P).toBeLessThanOrEqual(B);
      expect(P).toBeGreaterThanOrEqual(0);
    } else {
      for (const e of result.economic) {
        expect(e.finalWealth).toBe(B);
      }
    }
    const sumU = result.training.reduce((a, t) => a + t.utilityNumerator, 0);
    expect(sumU).toBe(0);
    for (const t of result.training) {
      expect(t.utilityDenominator).toBe(4 * B);
    }
    const soldReveals = state.reveals.filter((r) => r.outcome === "sold");
    expect(soldReveals.length).toBe(hasBuyer ? 1 : 0);
  }
  for (const reveal of state.reveals) {
    for (const amount of Object.values(reveal.bids)) {
      expect(Number.isSafeInteger(amount)).toBe(true);
      expect(amount).toBeGreaterThanOrEqual(0);
      expect(amount).toBeLessThanOrEqual(B);
    }
  }
  for (const seatId of SEAT_IDS) {
    const obs = observeSeat(runtime, state, seatId);
    const pub = observePublic(runtime, state);
    for (const slot of obs.slots) {
      const trueItem = state.lot?.slots.find((s) => s.slotId === slot.slotId);
      if (trueItem) {
        expect(slot.candidates.candidateIds).toContain(trueItem.itemId);
      }
    }
    for (const slot of pub.slots) {
      if (state.phase.kind !== "completed") {
        expect(slot.knownFields.identity).toBeUndefined();
      }
    }
  }
}

describe("demo.v0 property tests", () => {
  it("random legal-ish command sequences keep invariants and determinism", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 24 }), fc.integer({ min: 0, max: 120 }), (seed, steps) => {
        const run = (): MatchState => {
          let state = createMatch({ matchId: "prop", seed, runtime });
          let rngSeed = steps;
          const next = (): number => {
            rngSeed = (rngSeed * 1103515245 + 12345) & 0x7fffffff;
            return rngSeed;
          };
          for (let i = 0; i < steps && state.phase.kind !== "completed"; i++) {
            const arb = commandArb(state);
            const sample = fc.sample(arb, { numRuns: 1, seed: next() })[0]!;
            const result = transition(runtime, state, sample);
            if (result.kind === "accepted") {
              state = result.nextState;
            }
          }
          return state;
        };
        const a = run();
        const b = run();
        expect(hashState(a)).toBe(hashState(b));
        checkInvariants(a);
      }),
      { numRuns: 60 },
    );
  });

  it("full matches to completion under deadline-only drive", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 16 }), (seed) => {
        let state = createMatch({ matchId: "prop2", seed, runtime });
        for (const seatId of SEAT_IDS) {
          let r = transition(runtime, state, {
            kind: "select_loadout",
            seatId,
            analystId: ANALYSTS[0]!,
            toolPackageId: KITS[0]!,
          });
          if (r.kind === "accepted") state = r.nextState;
          r = transition(runtime, state, { kind: "lock_setup", seatId });
          if (r.kind === "accepted") state = r.nextState;
        }
        let guard = 0;
        while (state.phase.kind !== "completed" && guard++ < 10) {
          const window = state.window;
          if (!window) break;
          for (const participant of window.participants) {
            const r = transition(runtime, state, {
              kind: "submit_bid",
              seatId: participant,
              amount: (guard * 137 + participant.length) % (B + 1),
              actionWindowId: window.actionWindowId,
            });
            if (r.kind === "accepted") state = r.nextState;
          }
          const dl = transition(runtime, state, {
            kind: "deadline_reached",
            actionWindowId: window.actionWindowId,
          });
          if (dl.kind === "accepted") state = dl.nextState;
        }
        expect(state.phase.kind).toBe("completed");
        checkInvariants(state);
      }),
      { numRuns: 40 },
    );
  });
});
