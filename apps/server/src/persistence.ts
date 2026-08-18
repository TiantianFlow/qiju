import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { MatchResult } from "@qiju/game-core";
import { POCKET_OPENING_BALANCE } from "@qiju/ranking";

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
  pocketBalance: number;
  wins: number;
  losses: number;
  pushes: number;
  bestDenseEconomicRank: number | null;
}

/** A player with no matches has a real opening pocket, not a zero. */
export const ZERO_CAREER: CareerAggregates = {
  matchesPlayed: 0,
  pocketBalance: POCKET_OPENING_BALANCE,
  wins: 0,
  losses: 0,
  pushes: 0,
  bestDenseEconomicRank: null,
};

/**
 * The storage seam. Unit tests inject fakes (including a throwing one to
 * prove fail-open); production and integration tests use the real Supabase
 * store built on the secret key.
 */
export interface LeaderboardRow {
  userId: string;
  matchesPlayed: number;
  wins: number;
  losses: number;
  pushes: number;
  pocketBalance: number;
  rank: number;
  total: number;
}

export interface MatchPersistenceStore {
  /** Insert the match + seat rows idempotently; throw on failure — callers must swallow. */
  insertMatch(input: PersistedMatchInput): Promise<void>;
  /** Aggregate the caller's own human-seat rows; opening pocket when none. */
  careerForUser(userId: string): Promise<CareerAggregates>;
  /** THE-60: one page of the pocket leaderboard via the service-role-only v2 RPC. */
  leaderboardPage(offset: number, limit: number): Promise<{ rows: LeaderboardRow[]; total: number }>;
  /** THE-39: does the conversion snapshot exist for this user? (fail-closed contract) */
  snapshotExists(userId: string): Promise<boolean>;
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
      // THE-43: match row + all seat rows are ONE transaction via the
      // record_match_completion_v1 RPC. The old path upserted the match and
      // the seats as two independent statements, so "first completion wins"
      // was not guaranteed: a delayed continuation between the two writes
      // let a second finisher's seat rows land first, crediting them with
      // the first finisher's match metadata. First completion wins is
      // preserved by the RPC's ON CONFLICT DO NOTHING clauses — a replayed
      // deterministic id is a complete no-op, match and seats together.
      const { error } = await client.rpc("record_match_completion_v1", {
        p_match_id: input.matchId,
        p_mode: input.mode,
        p_seed: input.seed,
        p_rule_bundle_id: input.ruleBundleId,
        p_rule_manifest_hash: input.ruleManifestHash,
        p_content_hash: input.contentHash,
        p_final_state_hash: input.finalStateHash,
        p_seats: input.seats.map((s) => ({
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
      });
      if (error) throw new Error(`match completion record failed: ${error.message}`);
    },

    async careerForUser(userId) {
      const { data, error } = await client
        .from("match_seats")
        .select("match_id, realized_profit, dense_economic_rank")
        .eq("user_id", userId);
      if (error) throw new Error(`career query failed: ${error.message}`);
      const rows = (data ?? []) as Array<{
        match_id: string;
        realized_profit: number | string;
        dense_economic_rank: number;
      }>;
      if (rows.length === 0) return { ...ZERO_CAREER };
      // matchesPlayed counts DISTINCT matches: a user could in principle
      // hold several seats; one match is one played game.
      //
      // LATENT ASSUMPTION (recorded, deliberately not restructured):
      // wins/losses/pushes count human seat ROWS. Today's modes have
      // exactly one human seat per match, so row counts and match counts
      // coincide. A future multi-human mode must revisit this — the same
      // assumption is pinned in leaderboard_page_v2 and test M14.
      const matches = new Set(rows.map((r) => r.match_id));
      const num = (v: number | string): number => (typeof v === "string" ? Number(v) : v);
      let wins = 0;
      let losses = 0;
      let pushes = 0;
      let realizedSum = 0;
      for (const r of rows) {
        const profit = num(r.realized_profit);
        realizedSum += profit;
        if (profit > 0) wins += 1;
        else if (profit < 0) losses += 1;
        else pushes += 1;
      }
      return {
        matchesPlayed: matches.size,
        pocketBalance: POCKET_OPENING_BALANCE + realizedSum,
        wins,
        losses,
        pushes,
        bestDenseEconomicRank: Math.min(...rows.map((r) => r.dense_economic_rank)),
      };
    },

    async leaderboardPage(offset, limit) {
      const { data, error } = await client.rpc("leaderboard_page_v2", {
        p_offset: offset,
        p_limit: limit,
      });
      if (error) throw new Error(`leaderboard query failed: ${error.message}`);
      const num = (v: number | string): number => (typeof v === "string" ? Number(v) : v);
      const rows = (data ?? []) as Array<{
        user_id: string;
        matches_played: number | string;
        wins: number | string;
        losses: number | string;
        pushes: number | string;
        pocket_balance: number | string;
        rank: number | string;
        total: number | string;
      }>;
      return {
        rows: rows.map((r) => ({
          userId: r.user_id,
          matchesPlayed: num(r.matches_played),
          wins: num(r.wins),
          losses: num(r.losses),
          pushes: num(r.pushes),
          pocketBalance: num(r.pocket_balance),
          rank: num(r.rank),
          total: num(r.total),
        })),
        total: rows.length > 0 ? num(rows[0]!.total) : 0,
      };
    },

    async snapshotExists(userId) {
      const { count, error } = await client
        .from("account_conversion_snapshots")
        .select("user_id", { count: "exact", head: true })
        .eq("user_id", userId);
      if (error) throw new Error(`snapshot query failed: ${error.message}`);
      return (count ?? 0) > 0;
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
      // THE-44: the log SINK is inside the fail-open contract too. If it
      // throws, the throw escapes this .catch callback and the derived
      // promise rejects unobserved — an unhandled rejection off the back of
      // a correctly-swallowed database error. Swallow sink failures: a
      // broken logger must not break the match.
      try {
        logError(err instanceof Error ? err.message : String(err));
      } catch {
        /* fail-open applies to the sink as well */
      }
    });
}
