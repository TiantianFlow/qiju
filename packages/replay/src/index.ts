import {
  hashState,
  transition,
  type CompiledRuleRuntime,
  type GameCommand,
  type MatchState,
} from "@qiju/game-core";

export interface ReplayFile {
  schemaVersion: 1;
  matchId: string;
  seed: string;
  ruleBundleId: string;
  ruleManifestHash: string;
  contentHash: string;
  commands: GameCommand[];
  finalStateHash: string;
}

export function verifyReplay(
  runtime: CompiledRuleRuntime,
  initialState: MatchState,
  replay: ReplayFile,
): { ok: boolean; mismatchAtRevision?: number; expectedHash?: string; actualHash?: string } {
  let state = initialState;
  for (const command of replay.commands) {
    const result = transition(runtime, state, command);
    if (result.kind !== "accepted") {
      return {
        ok: false,
        mismatchAtRevision: state.revision,
        expectedHash: "accepted",
        actualHash: result.code,
      };
    }
    state = result.nextState;
  }
  const actual = hashState(state);
  if (actual !== replay.finalStateHash) {
    return {
      ok: false,
      mismatchAtRevision: state.revision,
      expectedHash: replay.finalStateHash,
      actualHash: actual,
    };
  }
  return { ok: true };
}

export * from "./driver.js";
