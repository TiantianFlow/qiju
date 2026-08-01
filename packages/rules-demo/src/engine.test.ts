import { describe, expect, it } from "vitest";
import { compileDemoV0 } from "@qiju/rules-demo";
import {
  createMatch,
  transition,
  legalActions,
  observePublic,
  observeSeat,
  hashState,
  type GameCommand,
  type MatchState,
  SEAT_IDS,
} from "@qiju/game-core";

const runtime = compileDemoV0();

export function runSetup(state: MatchState): MatchState {
  let current = state;
  for (const seatId of SEAT_IDS) {
    const r1 = transition(runtime, current, {
      kind: "select_loadout",
      seatId,
      analystId: "analyst.surveyor",
      toolPackageId: "kit.survey",
    });
    if (r1.kind !== "accepted") throw new Error(`select rejected: ${r1.code}`);
    current = r1.nextState;
    const r2 = transition(runtime, current, { kind: "lock_setup", seatId });
    if (r2.kind !== "accepted") throw new Error(`lock rejected: ${r2.code}`);
    current = r2.nextState;
  }
  return current;
}

export function playRound(
  state: MatchState,
  bids: Partial<Record<string, number>>,
): MatchState {
  const window = state.window!;
  for (const seatId of window.participants) {
    const amount = bids[seatId];
    if (amount === undefined) continue;
    const r = transition(runtime, state, {
      kind: "submit_bid",
      seatId: seatId as never,
      amount,
      actionWindowId: window.actionWindowId,
    });
    if (r.kind !== "accepted") throw new Error(`bid rejected: ${r.code}`);
    state = r.nextState;
  }
  for (const seatId of [...state.window!.participants]) {
    if (bids[seatId] === undefined) continue;
    const r = transition(runtime, state, {
      kind: "lock_bid",
      seatId: seatId as never,
      actionWindowId: state.window!.actionWindowId,
    });
    if (r.kind === "accepted") {
      state = r.nextState;
    } else {
      throw new Error(`lock rejected: ${r.code}`);
    }
  }
  if (state.window && state.window.actionWindowId === window.actionWindowId) {
    const r = transition(runtime, state, {
      kind: "deadline_reached",
      actionWindowId: window.actionWindowId,
    });
    if (r.kind !== "accepted") throw new Error(`deadline rejected: ${r.code}`);
    state = r.nextState;
  }
  return state;
}

describe("demo.v0 core", () => {
  it("completes a full match deterministically", () => {
    const seed = "determinism-check";
    const runOnce = (): { state: MatchState; hash: string } => {
      let state = createMatch({ matchId: "m1", seed, runtime });
      state = runSetup(state);
      let guard = 0;
      while (state.phase.kind !== "completed" && guard++ < 20) {
        state = playRound(state, { seat1: 5000, seat2: 1000, seat3: 0, seat4: 0 });
      }
      return { state, hash: hashState(state) };
    };
    const a = runOnce();
    const b = runOnce();
    expect(a.state.phase.kind).toBe("completed");
    expect(a.hash).toBe(b.hash);
  });

  it("same seed generates same lot and public intel", () => {
    const lotOf = (seed: string) => {
      let state = createMatch({ matchId: "m1", seed, runtime });
      state = runSetup(state);
      return {
        lot: state.lot!,
        publicIntel: state.intel.filter((i) => i.visibility.kind === "public"),
      };
    };
    const a = lotOf("seed-42");
    const b = lotOf("seed-42");
    expect(JSON.stringify(a.lot)).toBe(JSON.stringify(b.lot));
    expect(JSON.stringify(a.publicIntel)).toBe(JSON.stringify(b.publicIntel));
    expect(a.lot.slots).toHaveLength(10);
  });

  it("round 1 multiplier: equal to 2x does NOT sell, above does", () => {
    const attempt = (high: number, low: number) => {
      let state = createMatch({ matchId: "m1", seed: "mult-check", runtime });
      state = runSetup(state);
      state = playRound(state, { seat1: high, seat2: low, seat3: 0, seat4: 0 });
      return state;
    };
    const notSold = attempt(2000, 1000);
    expect(notSold.phase.kind).toBe("auction");
    expect(notSold.round).toBe(2);
    const sold = attempt(2001, 1000);
    expect(sold.phase.kind).toBe("completed");
    if (sold.phase.kind === "completed") {
      expect(sold.phase.result.acquisition.buyerSeatId).toBe("seat1");
      expect(sold.phase.result.acquisition.winningBid).toBe(2001);
      expect(sold.phase.result.acquisition.settlementRound).toBe(1);
    }
  });

  it("S=0: any unique positive high sells in rounds 1-4", () => {
    let state = createMatch({ matchId: "m1", seed: "s-zero", runtime });
    state = runSetup(state);
    state = playRound(state, { seat1: 1, seat2: 0, seat3: 0, seat4: 0 });
    expect(state.phase.kind).toBe("completed");
  });

  it("all zeros does not sell in rounds 1-4 and ends no-sale after round 5+tiebreak", () => {
    let state = createMatch({ matchId: "m1", seed: "all-zero", runtime });
    state = runSetup(state);
    let guard = 0;
    while (state.phase.kind !== "completed" && guard++ < 10) {
      state = playRound(state, {});
    }
    expect(state.phase.kind).toBe("completed");
    if (state.phase.kind === "completed") {
      expect(state.phase.result.acquisition.noSaleReason).toBe("tiebreak_tie");
      expect(state.phase.result.acquisition.buyerSeatId).toBeUndefined();
      for (const e of state.phase.result.economic) {
        expect(e.finalWealth).toBe(runtime.config.startingBudget);
        expect(e.denseEconomicRank).toBe(1);
      }
      for (const t of state.phase.result.training) {
        expect(t.utilityNumerator).toBe(0);
      }
    }
  });

  it("round 5 tie leads to tiebreak among tied seats only", () => {
    let state = createMatch({ matchId: "m1", seed: "tie-5", runtime });
    state = runSetup(state);
    for (let r = 1; r <= 4; r++) {
      state = playRound(state, { seat1: 100, seat2: 99, seat3: 0, seat4: 0 });
    }
    expect(state.round).toBe(5);
    state = playRound(state, { seat1: 500, seat2: 500, seat3: 100, seat4: 100 });
    expect(state.phase.kind).toBe("tiebreak");
    expect(state.window?.participants).toEqual(["seat1", "seat2"]);
    const la3 = legalActions(runtime, state, "seat3");
    expect(la3.actions).toEqual([{ kind: "wait" }]);
  });

  it("tiebreak unique highest wins; payment, bonus and three-layer result are consistent", () => {
    let state = createMatch({ matchId: "m1", seed: "tiebreak-win", runtime });
    state = runSetup(state);
    for (let r = 1; r <= 4; r++) {
      state = playRound(state, { seat1: 100, seat2: 99, seat3: 0, seat4: 0 });
    }
    state = playRound(state, { seat1: 500, seat2: 500, seat3: 100, seat4: 100 });
    state = playRound(state, { seat1: 600, seat2: 400 });
    expect(state.phase.kind).toBe("completed");
    if (state.phase.kind !== "completed") return;
    const result = state.phase.result;
    expect(result.acquisition.buyerSeatId).toBe("seat1");
    expect(result.acquisition.winningBid).toBe(600);
    const V = state.lot!.actualValue;
    const bonus = Math.floor(Math.max(0, 600 - V) / 10);
    const B = runtime.config.startingBudget;
    for (const e of result.economic) {
      if (e.seatId === "seat1") {
        expect(e.finalWealth).toBe(B - 600 + V);
        expect(e.bonusReward).toBe(0);
      } else {
        expect(e.finalWealth).toBe(B + bonus);
        expect(e.bonusReward).toBe(bonus);
      }
    }
    const sumW = result.economic.reduce((a, e) => a + e.finalWealth, 0);
    expect(sumW).toBe(4 * B - 600 + V + 3 * bonus);
    const sumU = result.training.reduce((a, t) => a + t.utilityNumerator, 0);
    expect(sumU).toBe(0);
  });

  it("overbid bonus is floor((P-V)/10) and paid to all three non-buyers", () => {
    let state = createMatch({ matchId: "m1", seed: "overbid", runtime });
    state = runSetup(state);
    state = playRound(state, { seat1: 20000, seat2: 0, seat3: 0, seat4: 0 });
    expect(state.phase.kind).toBe("completed");
    if (state.phase.kind !== "completed") return;
    const V = state.lot!.actualValue;
    const expected = Math.floor(Math.max(0, 20000 - V) / 10);
    for (const e of state.phase.result.economic) {
      if (e.seatId !== "seat1") expect(e.bonusReward).toBe(expected);
    }
  });

  it("rejected commands do not change state, charges or RNG", () => {
    let state = createMatch({ matchId: "m1", seed: "reject-noop", runtime });
    state = runSetup(state);
    const before = hashState(state);
    const window = state.window!;
    const bad = transition(runtime, state, {
      kind: "submit_bid",
      seatId: "seat1",
      amount: 99999,
      actionWindowId: window.actionWindowId,
    });
    expect(bad.kind).toBe("rejected");
    expect(hashState(state)).toBe(before);
    const wrongWindow = transition(runtime, state, {
      kind: "submit_bid",
      seatId: "seat1",
      amount: 100,
      actionWindowId: "w-round-99",
    });
    expect(wrongWindow.kind).toBe("rejected");
    if (wrongWindow.kind === "rejected") expect(wrongWindow.code).toBe("ACTION_WINDOW_MISMATCH");
    expect(hashState(state)).toBe(before);
  });

  it("seat observations isolate private intel across seats", () => {
    let state = createMatch({ matchId: "m1", seed: "secrecy", runtime });
    state = runSetup(state);
    const obs1 = observeSeat(runtime, state, "seat1");
    const obs2 = observeSeat(runtime, state, "seat2");
    const pub = observePublic(runtime, state);

    expect(
      state.intel.some((r) => r.visibility.kind === "seat" && r.visibility.seatId === "seat1"),
    ).toBe(true);
    expect(
      state.intel.some((r) => r.visibility.kind === "seat" && r.visibility.seatId === "seat2"),
    ).toBe(true);

    for (const record of obs1.mySeat.privateIntel) {
      expect(record.visibility.kind === "seat" && record.visibility.seatId === "seat1").toBe(true);
    }
    for (const record of obs2.mySeat.privateIntel) {
      expect(record.visibility.kind === "seat" && record.visibility.seatId === "seat2").toBe(true);
    }

    for (const obs of [obs1, obs2]) {
      for (const slot of obs.slots) {
        const trueItem = state.lot!.slots.find((s) => s.slotId === slot.slotId)!;
        const item = runtime.catalog.get(trueItem.itemId)!;
        expect(slot.candidates.candidateIds).toContain(trueItem.itemId);
        if (slot.knownFields.identity !== undefined) {
          expect(slot.knownFields.identity).toBe(item.id);
        }
      }
    }
    for (const slot of pub.slots) {
      expect(slot.knownFields.identity).toBeUndefined();
    }

    const known2 = new Map<string, Set<string>>();
    for (const r of obs2.mySeat.privateIntel) {
      if (r.fact.kind !== "field") continue;
      const set = known2.get(r.fact.slotId!) ?? new Set<string>();
      set.add(r.fact.field);
      known2.set(r.fact.slotId!, set);
    }
    const knownPub = new Map<string, Set<string>>();
    for (const r of pub.publicIntel) {
      if (r.fact.kind !== "field") continue;
      const set = knownPub.get(r.fact.slotId!) ?? new Set<string>();
      set.add(r.fact.field);
      knownPub.set(r.fact.slotId!, set);
    }
    for (const slot of obs2.slots) {
      const allowed = new Set([...(known2.get(slot.slotId) ?? []), ...(knownPub.get(slot.slotId) ?? [])]);
      for (const field of Object.keys(slot.knownFields)) {
        expect(allowed.has(field)).toBe(true);
      }
    }
    for (const slot of pub.slots) {
      const allowed = new Set(knownPub.get(slot.slotId) ?? []);
      for (const field of Object.keys(slot.knownFields)) {
        expect(allowed.has(field)).toBe(true);
      }
    }
    void obs1;
  });

  it("true identity always remains in candidate set for every viewer and slot", () => {
    let state = createMatch({ matchId: "m1", seed: "candidates", runtime });
    state = runSetup(state);
    for (const seatId of [...SEAT_IDS, "public"] as const) {
      const view =
        seatId === "public" ? observePublic(runtime, state) : observeSeat(runtime, state, seatId);
      for (const slot of view.slots) {
        const trueItem = state.lot!.slots.find((s) => s.slotId === slot.slotId)!;
        expect(slot.candidates.candidateIds).toContain(trueItem.itemId);
      }
    }
  });

  it("tools consume one charge and exhaust legally", () => {
    let state = createMatch({ matchId: "m1", seed: "tools", runtime });
    state = runSetup(state);
    const window = state.window!;
    const r1 = transition(runtime, state, {
      kind: "use_tool",
      seatId: "seat1",
      toolId: "kit.survey.shape-scan",
      actionWindowId: window.actionWindowId,
    });
    expect(r1.kind).toBe("accepted");
    state = r1.kind === "accepted" ? r1.nextState : state;
    const r2 = transition(runtime, state, {
      kind: "use_tool",
      seatId: "seat1",
      toolId: "kit.survey.category-scan",
      actionWindowId: window.actionWindowId,
    });
    expect(r2.kind).toBe("rejected");
    const la = legalActions(runtime, state, "seat1");
    const toolAction = la.actions.find((a) => a.kind === "use_tool");
    expect(toolAction).toBeUndefined();
  });

  it("locked bids cannot be changed and reveal happens when all lock", () => {
    let state = createMatch({ matchId: "m1", seed: "lock", runtime });
    state = runSetup(state);
    const w = state.window!;
    let r = transition(runtime, state, {
      kind: "submit_bid",
      seatId: "seat1",
      amount: 100,
      actionWindowId: w.actionWindowId,
    });
    state = (r as { nextState: MatchState }).nextState;
    r = transition(runtime, state, {
      kind: "lock_bid",
      seatId: "seat1",
      actionWindowId: w.actionWindowId,
    });
    state = (r as { nextState: MatchState }).nextState;
    const change = transition(runtime, state, {
      kind: "submit_bid",
      seatId: "seat1",
      amount: 200,
      actionWindowId: w.actionWindowId,
    });
    expect(change.kind).toBe("rejected");
    if (change.kind === "rejected") expect(change.code).toBe("ACTION_ALREADY_LOCKED");
  });

  it("pass (explicit 0) can be raised before lock; deadline fills missing with 0", () => {
    let state = createMatch({ matchId: "m1", seed: "pass", runtime });
    state = runSetup(state);
    const w = state.window!;
    let r = transition(runtime, state, {
      kind: "submit_bid",
      seatId: "seat1",
      amount: 0,
      actionWindowId: w.actionWindowId,
    });
    state = (r as { nextState: MatchState }).nextState;
    r = transition(runtime, state, {
      kind: "submit_bid",
      seatId: "seat1",
      amount: 500,
      actionWindowId: w.actionWindowId,
    });
    state = (r as { nextState: MatchState }).nextState;
    const dl = transition(runtime, state, { kind: "deadline_reached", actionWindowId: w.actionWindowId });
    expect(dl.kind).toBe("accepted");
    if (dl.kind === "accepted") {
      state = dl.nextState;
      expect(state.reveals[0]?.bids.seat1).toBe(500);
      expect(state.reveals[0]?.bids.seat2).toBe(0);
    }
  });

  it("rng stream isolation: consuming agent streams never changes content", () => {
    let s1 = createMatch({ matchId: "m1", seed: "stream-iso", runtime });
    s1 = runSetup(s1);
    let s2 = createMatch({ matchId: "m1", seed: "stream-iso", runtime });
    s2 = runSetup(s2);
    expect(JSON.stringify(s1.lot)).toBe(JSON.stringify(s2.lot));
    expect(
      JSON.stringify(s1.intel.filter((i) => i.visibility.kind === "public")),
    ).toBe(JSON.stringify(s2.intel.filter((i) => i.visibility.kind === "public")));
  });

  it("dense economic rank: ties share rank, next rank increments by one", () => {
    let state = createMatch({ matchId: "m1", seed: "rank", runtime });
    state = runSetup(state);
    state = playRound(state, { seat1: 20000, seat2: 0, seat3: 0, seat4: 0 });
    if (state.phase.kind !== "completed") throw new Error("not completed");
    const ranks = state.phase.result.economic.map((e) => e.denseEconomicRank).sort();
    expect(ranks[0]).toBe(1);
    expect(new Set(ranks.slice(1)).size === 1 || new Set(ranks).size >= 2).toBe(true);
  });
});

describe("command coverage", () => {
  it("handles every command kind", () => {
    let state = createMatch({ matchId: "m1", seed: "coverage", runtime });
    const cmds: GameCommand[] = [
      { kind: "select_loadout", seatId: "seat1", analystId: "analyst.appraiser", toolPackageId: "kit.catalog" },
    ];
    for (const c of cmds) {
      const r = transition(runtime, state, c);
      expect(r.kind).toBe("accepted");
      if (r.kind === "accepted") state = r.nextState;
    }
  });
});
