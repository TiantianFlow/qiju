import { describe, expect, it } from "vitest";
import { compileDemoV0 } from "@qiju/rules-demo";
import {
  createMatch,
  transition,
  observeSeat,
  legalActions,
  SEAT_IDS,
} from "@qiju/game-core";
import {
  BUILTIN_AGENTS,
  agentById,
  deterministicFallback,
} from "@qiju/agents";

const runtime = compileDemoV0();

async function setupToAuction() {
  let state = createMatch({ matchId: "agent-test", seed: "agent-seed", runtime });
  for (const seatId of SEAT_IDS) {
    let r = transition(runtime, state, {
      kind: "select_loadout",
      seatId,
      analystId: "analyst.appraiser",
      toolPackageId: "kit.appraisal",
    });
    if (r.kind === "accepted") state = r.nextState;
    r = transition(runtime, state, { kind: "lock_setup", seatId });
    if (r.kind === "accepted") state = r.nextState;
  }
  return state;
}

describe("agent contract", () => {
  it("all builtin agents return legal actions on real observations", async () => {
    const state = await setupToAuction();
    for (const agent of BUILTIN_AGENTS) {
      for (const seatId of SEAT_IDS) {
        const observation = observeSeat(runtime, state, seatId);
        const legal = legalActions(runtime, state, seatId);
        const context = {
          matchId: "agent-test",
          revision: state.revision,
          seatId,
          actionWindowId: state.window?.actionWindowId,
          ruleBundleId: "demo.v0",
          agentSeed: "contract",
          softTimeBudgetMs: 500,
        };
        const decision = await agent.decide({ observation, legalActions: legal, context });
        const result = transition(runtime, state, decision.action);
        expect(result.kind).toBe("accepted");
      }
    }
  });

  it("fixed seed produces reproducible actions", async () => {
    const state = await setupToAuction();
    const agent = agentById("balanced-calculator")!;
    const decide = async () => {
      const observation = observeSeat(runtime, state, "seat1");
      const legal = legalActions(runtime, state, "seat1");
      return agent.decide({
        observation,
        legalActions: legal,
        context: {
          matchId: "agent-test",
          revision: state.revision,
          seatId: "seat1",
          actionWindowId: state.window?.actionWindowId,
          ruleBundleId: "demo.v0",
          agentSeed: "fixed",
          softTimeBudgetMs: 500,
        },
      });
    };
    const a = await decide();
    const b = await decide();
    expect(JSON.stringify(a.action)).toBe(JSON.stringify(b.action));
  });

  it("deterministic fallback is always legal in setup and auction", async () => {
    let state = createMatch({ matchId: "fb", seed: "fb", runtime });
    for (const seatId of SEAT_IDS) {
      const obs = observeSeat(runtime, state, seatId);
      const legal = legalActions(runtime, state, seatId);
      const fb = deterministicFallback({
        observation: obs,
        legalActions: legal,
        context: {
          matchId: "fb",
          revision: state.revision,
          seatId,
          ruleBundleId: "demo.v0",
          agentSeed: "fb",
          softTimeBudgetMs: 0,
        },
      });
      const r = transition(runtime, state, fb.action);
      expect(r.kind).toBe("accepted");
      if (r.kind === "accepted") state = r.nextState;
      const obs2 = observeSeat(runtime, state, seatId);
      const legal2 = legalActions(runtime, state, seatId);
      const fb2 = deterministicFallback({
        observation: obs2,
        legalActions: legal2,
        context: {
          matchId: "fb",
          revision: state.revision,
          seatId,
          ruleBundleId: "demo.v0",
          agentSeed: "fb",
          softTimeBudgetMs: 0,
        },
      });
      const r2 = transition(runtime, state, fb2.action);
      expect(r2.kind).toBe("accepted");
      if (r2.kind === "accepted") state = r2.nextState;
    }
    expect(state.phase.kind).toBe("auction");
  });

  it("agents never receive hidden truth in observation", async () => {
    const state = await setupToAuction();
    for (const seatId of SEAT_IDS) {
      const observation = observeSeat(runtime, state, seatId);
      const json = JSON.stringify(observation);
      expect(json.includes("hiddenProfile")).toBe(false);
      expect(json.includes("hiddenThemeCategories")).toBe(false);
      expect(json.includes(String(state.lot!.actualValue))).toBe(false);
      expect(json).not.toContain("actualValue");
    }
  });
});
