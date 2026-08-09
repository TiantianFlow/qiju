import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { MatchResult } from "@qiju/game-core";

/**
 * THE-37b — durable match persistence and career statistics.
 *
 * Design contract (see the approved plan):
 * - FIRST COMPLETION WINS. `ALLOW_FIXED_SEED` is true in production and
 *   matchId is derived deterministically from the seed, and match creation
 *   deletes-and-recreates a room with an existing id — so the same match id
 *   completes repeatedly. The write is INSERT ... ON CONFLICT DO NOTHING;
 *   a replayed seed is a logged no-op and career never double-counts.
 * - PERSISTENCE FAILS OPEN. A database error is logged and swallowed —
 *   never thrown, never blocking the `match_completed` push, never failing
 *   the match. This is deliberately the opposite of 37a's auth rule:
 *   auth fails closed to protect identity, persistence fails open to
 *   protect the game.
 * - ALL-AI MATCHES NEVER TOUCH CAREER. Agent seats carry user_id = NULL
 *   in SQL, so no economic result can be attributed to any user by
 *   construction.
 * - CAREER IS COMPUTED, NOT STORED. Aggregates are derived in SQL over
 *   the persisted rows; there is no career_stats table.
 * - SERVER-AUTHORITATIVE. All access uses the secret key (RLS deny-by-
 *   default on both tables); the publishable key can neither read nor
 *   write them.
 */

export interface PersistedSeatInput {
  seatId: string;
  controllerKind: "human" | "agent";
  /** Null for agent seats — the load-bearing column for the all-AI rule. */
  userId: string | null;
  finalWealth: number;
  realizedProfit: number;
  bonusReward: number;
  denseEconomicRank: number;
  utilityNumerator: number;
  utilityDenominator: number;
}

export interface PersistedMatchInput {
  matchId: string;
  mode: "human-vs-ai" | "all-ai";
  seed: string;
  ruleBundleId: string;
  ruleManifestHash: string;
  contentHash: string;
  finalStateHash: string;
  seats: PersistedSeatInput[];
}

export interface CareerAggregates {
  matchesPlayed: number;
  totalFinalWealth: number;
  totalRealizedProfit: number;
  totalBonusReward: number;
  bestDenseEconomicRank: number | null;
  /** average finalWealth across the caller's human seats. */
  averageFinalWealth: number;
}

export const ZERO_CAREER: CareerAggregates = {
  matchesPlayed: 0,
  totalFinalWealth: 0,
  totalRealizedProfit: 0,
  totalBonusReward: 0,
  bestDenseEconomicRank: null,
  averageFinalWealth: 0,
};

/**
 * The storage seam. Unit tests inject fakes (including a throwing one to
 * prove fail-open); production and integration tests use the real Supabase
 * store built on the secret key.
 */
export interface MatchPersistenceStore {
  /** Insert the match + seat rows idempotently; throw on failure — callers must swallow. */
  insertMatch(input: PersistedMatchInput): Promise<void>;
  /** Aggregate the caller's own human-seat rows; zeroed aggregates when none. */
  careerForUser(userId: string): Promise<CareerAggregates>;
}

/** Overridable seam for fault injection in tests; default is the real factory. */
export const persistenceDeps: {
  storeFactory: (env: {
    SUPABASE_URL: string;
    SUPABASE_SECRET_KEY: string;
  }) => MatchPersistenceStore;
} = {
  storeFactory: (env) =>
    createSupabaseStore(
      createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      }),
    ),
};

/** Real store: secret-key client (bypasses RLS), one instance per app. */
export function createSupabaseStore(client: SupabaseClient): MatchPersistenceStore {
  return {
    async insertMatch(input) {
      // First completion wins: DO NOTHING when the deterministic id already
      // exists. PostgREST's on_conflict upsert with Prefer: resolution=ignore
      // is exactly that; a replayed seed returns 201 with no row change.
      const { error: matchError } = await client
        .from("matches")
        .upsert(
          {
            match_id: input.matchId,
            mode: input.mode,
            seed: input.seed,
            rule_bundle_id: input.ruleBundleId,
            rule_manifest_hash: input.ruleManifestHash,
            content_hash: input.contentHash,
            final_state_hash: input.finalStateHash,
          },
          { onConflict: "match_id", ignoreDuplicates: true },
        );
      if (matchError) throw new Error(`matches insert failed: ${matchError.message}`);
      const { error: seatsError } = await client
        .from("match_seats")
        .upsert(
          input.seats.map((s) => ({
            match_id: input.matchId,
            seat_id: s.seatId,
            controller_kind: s.controllerKind,
            user_id: s.userId,
            final_wealth: s.finalWealth,
            realized_profit: s.realizedProfit,
            bonus_reward: s.bonusReward,
            dense_economic_rank: s.denseEconomicRank,
            utility_numerator: s.utilityNumerator,
            utility_denominator: s.utilityDenominator,
          })),
          { onConflict: "match_id,seat_id", ignoreDuplicates: true },
        );
      if (seatsError) throw new Error(`match_seats insert failed: ${seatsError.message}`);
    },

    async careerForUser(userId) {
      const { data, error } = await client
        .from("match_seats")
        .select("match_id, final_wealth, realized_profit, bonus_reward, dense_economic_rank")
        .eq("user_id", userId);
      if (error) throw new Error(`career query failed: ${error.message}`);
      const rows = (data ?? []) as Array<{
        match_id: string;
        final_wealth: number | string;
        realized_profit: number | string;
        bonus_reward: number | string;
        dense_economic_rank: number;
      }>;
      if (rows.length === 0) return { ...ZERO_CAREER };
      // matchesPlayed counts DISTINCT matches: a user could in principle
      // hold several seats; one match is one played game.
      const matches = new Set(rows.map((r) => r.match_id));
      const num = (v: number | string): number => (typeof v === "string" ? Number(v) : v);
      const totalFinalWealth = rows.reduce((a, r) => a + num(r.final_wealth), 0);
      return {
        matchesPlayed: matches.size,
        totalFinalWealth,
        totalRealizedProfit: rows.reduce((a, r) => a + num(r.realized_profit), 0),
        totalBonusReward: rows.reduce((a, r) => a + num(r.bonus_reward), 0),
        bestDenseEconomicRank: Math.min(...rows.map((r) => r.dense_economic_rank)),
        averageFinalWealth: totalFinalWealth / rows.length,
      };
    },
  };
}

/** Extract the persistence input from an engine MatchResult + room metadata. */
export function buildPersistedMatch(input: {
  matchId: string;
  mode: "human-vs-ai" | "all-ai";
  seed: string;
  ruleBundleId: string;
  ruleManifestHash: string;
  contentHash: string;
  finalStateHash: string;
  result: MatchResult;
  seats: Array<{ seatId: string; kind: "human" | "agent"; principalId?: string }>;
}): PersistedMatchInput {
  const economicBySeat = new Map(input.result.economic.map((e) => [e.seatId, e]));
  const trainingBySeat = new Map(input.result.training.map((t) => [t.seatId, t]));
  return {
    matchId: input.matchId,
    mode: input.mode,
    seed: input.seed,
    ruleBundleId: input.ruleBundleId,
    ruleManifestHash: input.ruleManifestHash,
    contentHash: input.contentHash,
    finalStateHash: input.finalStateHash,
    seats: input.seats.map((seat) => {
      const eco = economicBySeat.get(seat.seatId as never);
      const util = trainingBySeat.get(seat.seatId as never);
      if (!eco || !util) {
        throw new Error(`settlement missing for ${seat.seatId}`);
      }
      return {
        seatId: seat.seatId,
        controllerKind: seat.kind,
        userId: seat.kind === "human" ? (seat.principalId ?? null) : null,
        finalWealth: eco.finalWealth,
        realizedProfit: eco.realizedProfit,
        bonusReward: eco.bonusReward,
        denseEconomicRank: eco.denseEconomicRank,
        utilityNumerator: util.utilityNumerator,
        utilityDenominator: util.utilityDenominator,
      };
    }),
  };
}

/**
 * Fire-and-forget persistence at the completion boundary. Fails OPEN:
 * every failure is logged via the provided sink and swallowed — this
 * function never throws and never rejects, so the `match_completed` push
 * is never blocked or delayed by a database problem.
 */
export function persistMatchCompletionFailOpen(
  store: MatchPersistenceStore,
  input: PersistedMatchInput,
  logError: (message: string) => void,
): void {
  Promise.resolve()
    .then(() => store.insertMatch(input))
    .catch((err: unknown) => {
      logError(err instanceof Error ? err.message : String(err));
    });
}
