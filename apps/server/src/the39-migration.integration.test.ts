import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type pg from "pg";
import {
  INITIAL_RATING,
  POCKET_OPENING_BALANCE,
  cumulativeRealizedProfit,
  pocketBalance,
  tycoonTier,
  updateAppraiserRating,
  winLossRecord,
} from "@qiju/ranking";
import type { MatchResult } from "@qiju/game-core";

/**
 * THE-39 increment 1 — database contract tests for
 * 20260809180000_the39_accounts_snapshot_leaderboard.sql.
 *
 * Talks to the local database directly over pg (not PostgREST) so the
 * tests can exercise auth.users state transitions and verify role ACLs —
 * neither is reachable through the REST API. Requires DATABASE_URL (the
 * local Supabase DB connection string) in the shell environment, or
 * SUPABASE_URL as the signal that the local stack is running.
 *
 * The RPC re-implements the Appraiser Rating formula in SQL; these tests
 * are the mandatory anti-drift contract against packages/ranking
 * (INITIAL_RATING, K=32/16, the match-20/21 boundary). If the ranking
 * formula ever changes, a NEW versioned RPC/snapshot version is required
 * — this suite must never be edited into agreement with a silent formula
 * change.
 */

const { DATABASE_URL, SUPABASE_URL } = process.env;
if (!DATABASE_URL && !SUPABASE_URL) {
  throw new Error(
    "THE-39 migration contract tests require DATABASE_URL (local Supabase DB " +
      "connection string, e.g. from `supabase status -o env`) or at minimum " +
      "SUPABASE_URL in the shell environment",
  );
}
if (!DATABASE_URL) {
  throw new Error(
    "THE-39 migration contract tests require DATABASE_URL — the direct Postgres " +
      "connection string — because they exercise auth.users transitions and role " +
      "ACLs that PostgREST cannot reach",
  );
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });

function q<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params);
}

async function createUser(isAnonymous: boolean): Promise<string> {
  // created_at is set explicitly so fixtures mirror real auth rows (and so
  // guest_created_at assertions have a real value to compare against).
  const { rows } = await q<{ id: string }>(
    `insert into auth.users (id, is_anonymous, created_at, updated_at)
     values (gen_random_uuid(), $1, now(), now()) returning id`,
    [isAnonymous],
  );
  return rows[0]!.id;
}

async function deleteUser(id: string): Promise<void> {
  await q(`delete from auth.users where id = $1`, [id]);
}

interface SeatInput {
  seatId: string;
  kind: "human" | "agent";
  userId: string | null;
  finalWealth: number;
  realizedProfit: number;
  bonusReward: number;
  denseEconomicRank: number;
  utilityNumerator: number;
  utilityDenominator: number;
}

function agentSeat(seatId: string, utility: number, profit: number): SeatInput {
  return {
    seatId,
    kind: "agent",
    userId: null,
    finalWealth: 100_000 + profit,
    realizedProfit: profit,
    bonusReward: 0,
    denseEconomicRank: 2,
    utilityNumerator: utility * 400_000,
    utilityDenominator: 400_000,
  };
}

function humanSeat(
  seatId: string,
  userId: string,
  utility: number,
  profit: number,
  overrides: Partial<SeatInput> = {},
): SeatInput {
  return {
    seatId,
    kind: "human",
    userId,
    finalWealth: 100_000 + profit,
    realizedProfit: profit,
    bonusReward: 0,
    denseEconomicRank: 1,
    utilityNumerator: utility * 400_000,
    utilityDenominator: 400_000,
    ...overrides,
  };
}

async function insertMatch(
  matchId: string,
  completedAt: string | null,
  seats: SeatInput[],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `insert into public.matches (match_id, mode, seed, rule_bundle_id, rule_manifest_hash, content_hash, final_state_hash, completed_at)
       values ($1, 'human-vs-ai', 'seed-' || $1, 'bundle', 'manifest', 'content', 'state',
               coalesce($2::timestamptz, now()))`,
      [matchId, completedAt],
    );
    for (const s of seats) {
      await client.query(
        `insert into public.match_seats (match_id, seat_id, controller_kind, user_id, final_wealth, realized_profit, bonus_reward, dense_economic_rank, utility_numerator, utility_denominator)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          matchId,
          s.seatId,
          s.kind,
          s.userId,
          s.finalWealth,
          s.realizedProfit,
          s.bonusReward,
          s.denseEconomicRank,
          s.utilityNumerator,
          s.utilityDenominator,
        ],
      );
    }
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

async function deleteMatch(matchId: string): Promise<void> {
  await q(`delete from public.match_seats where match_id = $1`, [matchId]);
  await q(`delete from public.matches where match_id = $1`, [matchId]);
}

/** Reference rating: fold packages/ranking over (utility, profit) match list. */
function referenceRating(matches: Array<{ utility: number }>): number {
  let rating = INITIAL_RATING;
  let completed = 0;
  for (const m of matches) {
    const result: MatchResult = {
      acquisition: {},
      economic: [],
      training: [
        {
          seatId: "seat1",
          utilityNumerator: m.utility * 400_000,
          utilityDenominator: 400_000,
        },
      ],
    };
    rating = updateAppraiserRating(rating, completed, result, "seat1");
    completed += 1;
  }
  return rating;
}

function profitResults(matches: Array<{ profit: number }>): MatchResult[] {
  return matches.map((m) => ({
    acquisition: {},
    economic: [
      {
        seatId: "seat1",
        finalWealth: 100_000 + m.profit,
        realizedProfit: m.profit,
        bonusReward: 0,
        denseEconomicRank: 1,
      },
    ],
    training: [],
  }));
}

function referenceProfit(matches: Array<{ profit: number }>): number {
  return cumulativeRealizedProfit(profitResults(matches), "seat1");
}

function referencePocket(matches: Array<{ profit: number }>): number {
  return pocketBalance(profitResults(matches), "seat1");
}

function referenceWinLoss(matches: Array<{ profit: number }>) {
  return winLossRecord(profitResults(matches), "seat1");
}

describe("THE-39 migration: conversion snapshot, leaderboard RPC, atomic writes", () => {
  const run = Date.now().toString(36);
  const mid = (n: string) => `the39-${run}-${n}`;
  const cleanupUsers: string[] = [];
  const cleanupMatches: string[] = [];

  afterAll(async () => {
    for (const m of cleanupMatches) await deleteMatch(m);
    for (const u of cleanupUsers) await deleteUser(u);
    await pool.end();
  });

  it("M1: a real is_anonymous true->false transition writes exactly one snapshot with career aggregates matching packages/ranking", async () => {
    const user = await createUser(true);
    cleanupUsers.push(user);
    const matches = [
      { utility: 0.5, profit: 10_000 },
      { utility: -0.25, profit: -5_000 },
      { utility: 0.1, profit: 2_000 },
    ];
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i]!;
      const matchId = mid(`m1-${i}`);
      cleanupMatches.push(matchId);
      await insertMatch(matchId, new Date(Date.now() + i * 1000).toISOString(), [
        humanSeat("seat1", user, m.utility, m.profit, { bonusReward: i === 0 ? 500 : 0 }),
        agentSeat("seat2", 0, 0),
        agentSeat("seat3", 0, 0),
        agentSeat("seat4", 0, 0),
      ]);
    }

    // The conversion event.
    const { rows: updated } = await q<{ id: string }>(
      `update auth.users set is_anonymous = false where id = $1 returning id`,
      [user],
    );
    expect(updated).toHaveLength(1);

    const { rows: snaps } = await q(
      `select * from public.account_conversion_snapshots where user_id = $1`,
      [user],
    );
    expect(snaps).toHaveLength(1);
    const snap = snaps[0]!;
    expect(snap.snapshot_version).toBe(2);
    expect(snap.rating_formula_version).toBe("appraiser-v1");
    expect(Number(snap.human_seat_rows)).toBe(3);
    expect(Number(snap.matches_played)).toBe(3);
    expect(Number(snap.appraiser_rating)).toBeCloseTo(referenceRating(matches), 9);
    expect(Number(snap.cumulative_realized_profit)).toBeCloseTo(referenceProfit(matches), 6);
    expect(Number(snap.pocket_balance)).toBeCloseTo(referencePocket(matches), 6);
    expect(Number(snap.wins)).toBe(referenceWinLoss(matches).wins);
    expect(Number(snap.losses)).toBe(referenceWinLoss(matches).losses);
    expect(Number(snap.pushes)).toBe(referenceWinLoss(matches).pushes);
    expect(Number(snap.total_bonus_reward)).toBe(500);
    expect(snap.best_dense_economic_rank).toBe(1);
    expect(Number(snap.rank_one_finishes)).toBe(3);
    expect(Number(snap.positive_profit_matches)).toBe(2);
    expect(snap.first_match_completed_at).not.toBeNull();
    expect(snap.last_match_completed_at).not.toBeNull();
    expect(Number(snap.source_max_match_seat_id)).toBeGreaterThan(0);
    expect(new Date(snap.converted_at as string).getTime()).toBeGreaterThanOrEqual(
      new Date(snap.guest_created_at as string).getTime(),
    );

    // Append-once: a redundant second transition attempt cannot create a
    // second row (the WHEN clause also blocks it, and ON CONFLICT covers
    // any internal re-evaluation within one statement).
    const { rows: snapsAfter } = await q(
      `select count(*)::bigint as c from public.account_conversion_snapshots where user_id = $1`,
      [user],
    );
    expect(Number(snapsAfter[0]!.c)).toBe(1);

    // A literal second true->false transition (auth shouldn't produce one,
    // but the trigger must be idempotent if it ever does): the WHEN clause
    // is satisfied again, the insert runs, and ON CONFLICT (user_id) DO
    // NOTHING leaves exactly one snapshot with the ORIGINAL values.
    const { rows: flipBack } = await q<{ is_anonymous: boolean }>(
      `update auth.users set is_anonymous = true where id = $1 returning is_anonymous`,
      [user],
    );
    expect(flipBack[0]!.is_anonymous).toBe(true); // false->true never fires
    await q(`update auth.users set is_anonymous = false where id = $1`, [user]);
    const { rows: snapsFinal } = await q(
      `select matches_played, cumulative_realized_profit, converted_at from public.account_conversion_snapshots where user_id = $1`,
      [user],
    );
    expect(snapsFinal).toHaveLength(1);
    expect(Number(snapsFinal[0]!.matches_played)).toBe(3);
    expect(Number(snapsFinal[0]!.cumulative_realized_profit)).toBeCloseTo(referenceProfit(matches), 6);
    expect(snapsFinal[0]!.converted_at).toEqual(snap.converted_at); // original, not overwritten
  });

  it("M2: a converting guest with zero career rows still gets a snapshot with zeroed aggregates and null time/rank fields", async () => {
    const user = await createUser(true);
    cleanupUsers.push(user);
    await q(`update auth.users set is_anonymous = false where id = $1`, [user]);
    const { rows } = await q(
      `select * from public.account_conversion_snapshots where user_id = $1`,
      [user],
    );
    expect(rows).toHaveLength(1);
    const snap = rows[0]!;
    expect(snap.snapshot_version).toBe(2);
    expect(Number(snap.matches_played)).toBe(0);
    expect(Number(snap.human_seat_rows)).toBe(0);
    expect(Number(snap.appraiser_rating)).toBe(INITIAL_RATING);
    expect(Number(snap.cumulative_realized_profit)).toBe(0);
    expect(Number(snap.pocket_balance)).toBe(POCKET_OPENING_BALANCE);
    expect(Number(snap.wins)).toBe(0);
    expect(Number(snap.losses)).toBe(0);
    expect(Number(snap.pushes)).toBe(0);
    expect(snap.best_dense_economic_rank).toBeNull();
    expect(snap.first_match_completed_at).toBeNull();
    expect(snap.last_match_completed_at).toBeNull();
  });

  it("M3: the trigger does not fire on an auth.identities INSERT for an already-permanent user", async () => {
    const user = await createUser(false); // permanent from the start — no transition
    cleanupUsers.push(user);
    const { rows: before } = await q(
      `select count(*)::bigint as c from public.account_conversion_snapshots where user_id = $1`,
      [user],
    );
    expect(Number(before[0]!.c)).toBe(0);

    // Adding a second provider identity is exactly the non-conversion
    // identity-insert event the design rejects as a trigger source.
    await q(
      `insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
       values (gen_random_uuid(), $1::uuid, 'provider-sub-' || $1::text, '{}'::jsonb, 'google', now(), now(), now())`,
      [user],
    );
    const { rows: after } = await q(
      `select count(*)::bigint as c from public.account_conversion_snapshots where user_id = $1`,
      [user],
    );
    expect(Number(after[0]!.c)).toBe(0);
  });

  it("M4: the trigger does not fire on non-conversion auth.users updates (false->false, email changes)", async () => {
    const user = await createUser(false);
    cleanupUsers.push(user);
    await q(`update auth.users set email = 'the39-${run}-m4@example.invalid', updated_at = now() where id = $1`, [user]);
    const { rows } = await q(
      `select count(*)::bigint as c from public.account_conversion_snapshots where user_id = $1`,
      [user],
    );
    expect(Number(rows[0]!.c)).toBe(0);
  });

  it("M5: the snapshot write FAILS CLOSED — a real failure of the snapshot INSERT itself aborts the conversion and is_anonymous stays true", async () => {
    const user = await createUser(true);
    cleanupUsers.push(user);
    // Break the snapshot INSERT itself (not a sibling trigger): a BEFORE
    // INSERT trigger on the snapshot table raises, so the trigger
    // function's own INSERT is what fails — the real failure path.
    await q(`
      create or replace function public.the39_test_fail_snapshot() returns trigger
      language plpgsql security definer set search_path = '' as $f$
      begin
        raise exception 'injected snapshot insert failure';
      end;
      $f$;
    `);
    await q(`
      create trigger the39_test_fail_snapshot_trg
        before insert on public.account_conversion_snapshots
        for each row
        execute function public.the39_test_fail_snapshot();
    `);
    try {
      await expect(
        q(`update auth.users set is_anonymous = false where id = $1`, [user]),
      ).rejects.toThrow(/injected snapshot insert failure/);
      // Rolled back: the user is still anonymous and no snapshot exists.
      const { rows: u } = await q<{ is_anonymous: boolean }>(
        `select is_anonymous from auth.users where id = $1`,
        [user],
      );
      expect(u[0]!.is_anonymous).toBe(true);
      const { rows: s } = await q(
        `select count(*)::bigint as c from public.account_conversion_snapshots where user_id = $1`,
        [user],
      );
      expect(Number(s[0]!.c)).toBe(0);
    } finally {
      await q(
        `drop trigger if exists the39_test_fail_snapshot_trg on public.account_conversion_snapshots`,
      );
      await q(`drop function if exists public.the39_test_fail_snapshot()`);
    }
  });

  it("M6: leaderboard RPC matches packages/ranking across the match 20/21 K boundary, orders deterministically, and paginates", async () => {
    const [boundary, other, guest] = await Promise.all([
      createUser(false),
      createUser(false),
      createUser(true),
    ]);
    cleanupUsers.push(boundary, other, guest);

    // Boundary user: 21 matches, utility +0.25 in matches 1..20 and -0.5
    // in match 21. Reference: 1000 + 20*32*0.25 + 16*(-0.5) = 1152.
    const boundaryMatches = Array.from({ length: 21 }, (_, i) => ({
      utility: i < 20 ? 0.25 : -0.5,
      profit: 1_000 * (i + 1),
    }));
    for (let i = 0; i < boundaryMatches.length; i++) {
      const m = boundaryMatches[i]!;
      const matchId = mid(`m6-b-${i}`);
      cleanupMatches.push(matchId);
      await insertMatch(matchId, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), [
        humanSeat("seat1", boundary, m.utility, m.profit),
        agentSeat("seat2", 0, 0),
        agentSeat("seat3", 0, 0),
        agentSeat("seat4", 0, 0),
      ]);
    }

    // Other permanent user: higher rating, fewer matches.
    const otherMatches = [{ utility: 0.9, profit: 50_000 }];
    const otherMatchId = mid("m6-o-0");
    cleanupMatches.push(otherMatchId);
    await insertMatch(otherMatchId, new Date(Date.UTC(2026, 0, 2)).toISOString(), [
      humanSeat("seat1", other, 0.9, 50_000),
      agentSeat("seat2", 0, 0),
      agentSeat("seat3", 0, 0),
      agentSeat("seat4", 0, 0),
    ]);

    // Guest user with a HUGE rating — must never appear on the leaderboard.
    const guestMatchId = mid("m6-g-0");
    cleanupMatches.push(guestMatchId);
    await insertMatch(guestMatchId, new Date(Date.UTC(2026, 0, 3)).toISOString(), [
      humanSeat("seat1", guest, 1.0, 1_000_000),
      agentSeat("seat2", 0, 0),
      agentSeat("seat3", 0, 0),
      agentSeat("seat4", 0, 0),
    ]);

    const { rows: page } = await q<{
      user_id: string;
      matches_played: string;
      cumulative_realized_profit: string;
      appraiser_rating: number;
      rank: string;
      total: string;
    }>(`select * from public.leaderboard_page_v1(0, 100)`);

    const ids = page.map((r) => r.user_id);
    expect(ids).toContain(boundary);
    expect(ids).toContain(other);
    expect(ids).not.toContain(guest); // literal is_anonymous IS FALSE exclusion

    const bRow = page.find((r) => r.user_id === boundary)!;
    expect(Number(bRow.matches_played)).toBe(21);
    expect(bRow.appraiser_rating).toBeCloseTo(referenceRating(boundaryMatches), 9);
    // The K boundary is load-bearing: 1152 exactly distinguishes K=16 at
    // match 21 from K=32 (which would give 1160).
    expect(bRow.appraiser_rating).toBeCloseTo(1152, 9);
    expect(Number(bRow.cumulative_realized_profit)).toBeCloseTo(referenceProfit(boundaryMatches), 6);
    expect(tycoonTier(Number(bRow.cumulative_realized_profit))).toBe("Novice Bidder");

    const oRow = page.find((r) => r.user_id === other)!;
    expect(oRow.appraiser_rating).toBeCloseTo(referenceRating(otherMatches), 9);

    // Ordering: other (1028.8) outranks boundary (1152)? No — 1152 > 1028.8.
    expect(Number(bRow.rank)).toBeLessThan(Number(oRow.rank));
    // Total counts only permanent users.
    expect(Number(bRow.total)).toBe(Number(oRow.total));

    // Pagination shape: page 2 (offset 1, limit 1) returns exactly one row
    // whose rank is 2 within this dataset, provided at least 2 exist.
    const { rows: page2 } = await q<typeof page[number]>(
      `select * from public.leaderboard_page_v1(1, 1)`,
    );
    expect(page2).toHaveLength(1);
    expect(Number(page2[0]!.rank)).toBe(2);
    expect(Number(page2[0]!.total)).toBe(Number(bRow.total));
  });

  it("M7: THE-43 — record_match_completion_v1 writes match + seats atomically and a concurrent same-id completion is a full no-op", async () => {
    const [alice, bob] = await Promise.all([createUser(true), createUser(true)]);
    cleanupUsers.push(alice, bob);
    const matchId = mid("m7");
    cleanupMatches.push(matchId);

    const seatsFor = (userId: string) => [
      humanSeat("seat1", userId, 0.4, 7_500),
      agentSeat("seat2", 0, 0),
      agentSeat("seat3", 0, 0),
      agentSeat("seat4", 0, 0),
    ];
    const payload = (userId: string) => [
      matchId,
      "human-vs-ai",
      `seed-${matchId}`,
      "bundle",
      "manifest",
      "content",
      "state",
      JSON.stringify(
        seatsFor(userId).map((s) => ({
          seat_id: s.seatId,
          controller_kind: s.kind,
          user_id: s.userId,
          final_wealth: s.finalWealth,
          realized_profit: s.realizedProfit,
          bonus_reward: s.bonusReward,
          dense_economic_rank: s.denseEconomicRank,
          utility_numerator: s.utilityNumerator,
          utility_denominator: s.utilityDenominator,
        })),
      ),
    ];

    // Two principals race the same deterministic match id on separate
    // pooled connections. Both RPC calls succeed (ON CONFLICT DO NOTHING
    // never errors); exactly one transaction wins the insert and owns
    // seat1 — and the whole unit (match row + all seat rows) comes from
    // that single winner. The winner is whatever the database says it is.
    const results = await Promise.allSettled([
      q(`select public.record_match_completion_v1($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, payload(alice)),
      q(`select public.record_match_completion_v1($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, payload(bob)),
    ]);
    for (const r of results) {
      expect(r.status).toBe("fulfilled");
    }

    const { rows: matchRows } = await q(
      `select * from public.matches where match_id = $1`,
      [matchId],
    );
    expect(matchRows).toHaveLength(1);
    const { rows: seatRows } = await q<{ seat_id: string; user_id: string | null }>(
      `select seat_id, user_id from public.match_seats where match_id = $1 order by seat_id`,
      [matchId],
    );
    expect(seatRows).toHaveLength(4);
    expect(seatRows[0]!.seat_id).toBe("seat1");
    const winner = seatRows[0]!.user_id;
    expect(winner === alice || winner === bob).toBe(true);
    // The loser's id appears nowhere.
    const loser = winner === alice ? bob : alice;
    expect(seatRows.every((s) => s.user_id !== loser)).toBe(true);

    // A sequential replay is likewise a full no-op.
    await q(`select public.record_match_completion_v1($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, payload(loser));
    const { rows: seatRows2 } = await q<{ user_id: string | null }>(
      `select user_id from public.match_seats where match_id = $1 and seat_id = 'seat1'`,
      [matchId],
    );
    expect(seatRows2[0]!.user_id).toBe(winner);
  });

  it("M8: THE-43 — a failing seat row aborts the whole unit: no match row, no seat rows", async () => {
    const user = await createUser(true);
    cleanupUsers.push(user);
    const matchId = mid("m8");
    // One seat violates the human/agent user invariant (human seat without
    // user_id): the CHECK constraint must roll back match + all seats.
    const badSeats = JSON.stringify([
      { seat_id: "seat1", controller_kind: "human", user_id: null, final_wealth: 1, realized_profit: 1, bonus_reward: 0, dense_economic_rank: 1, utility_numerator: 0, utility_denominator: 1 },
      { seat_id: "seat2", controller_kind: "agent", user_id: null, final_wealth: 1, realized_profit: 1, bonus_reward: 0, dense_economic_rank: 2, utility_numerator: 0, utility_denominator: 1 },
    ]);
    await expect(
      q(`select public.record_match_completion_v1($1,'human-vs-ai','s','b','m','c','st',$2::jsonb)`, [matchId, badSeats]),
    ).rejects.toThrow();
    const { rows: m } = await q(`select * from public.matches where match_id = $1`, [matchId]);
    const { rows: s } = await q(`select * from public.match_seats where match_id = $1`, [matchId]);
    expect(m).toHaveLength(0);
    expect(s).toHaveLength(0);
    cleanupMatches.push(matchId); // defensive; nothing to delete
  });

  it("M9: utility_denominator > 0 is enforced as a validated CHECK (packages/ranking rejects non-positive denominators; SQL must too)", async () => {
    const user = await createUser(true);
    cleanupUsers.push(user);
    const matchId = mid("m9");
    cleanupMatches.push(matchId);
    await q(
      `insert into public.matches (match_id, mode, seed, rule_bundle_id, rule_manifest_hash, content_hash, final_state_hash)
       values ($1, 'human-vs-ai', 's', 'b', 'm', 'c', 'st')`,
      [matchId],
    );
    await expect(
      q(
        `insert into public.match_seats (match_id, seat_id, controller_kind, user_id, final_wealth, realized_profit, bonus_reward, dense_economic_rank, utility_numerator, utility_denominator)
         values ($1, 'seat1', 'human', $2, 1, 1, 0, 1, 0, 0)`,
        [matchId, user],
      ),
    ).rejects.toThrow(/match_seats_utility_denominator_positive/);
    // The constraint is VALIDATED (not merely declared).
    const { rows } = await q<{ convalidated: boolean }>(
      `select convalidated from pg_constraint where conname = 'match_seats_utility_denominator_positive'`,
    );
    expect(rows[0]!.convalidated).toBe(true);
  });

  it("M10: THE-40 — default grants revoked on the new table; snapshot privileges are select-only for service_role", async () => {
    const { rows } = await q<{ rolname: string; privileges: string }>(
      `select r.rolname, coalesce(a.privileges, '{}'::text[]) as privileges
       from (values ('anon'), ('authenticated'), ('service_role')) as r(rolname)
       left join lateral (
         select array_agg(privilege_type) as privileges
         from information_schema.role_table_grants
         where table_schema = 'public'
           and table_name = 'account_conversion_snapshots'
           and grantee = r.rolname
       ) a on true`,
    );
    // pg parses text[] only when the driver can resolve the element type;
    // array_agg over the information_schema comes back as the literal
    // array string ("{}" / "{SELECT}"), so parse it explicitly.
    const parseArrayLiteral = (v: string | string[]): string[] => {
      if (Array.isArray(v)) return v;
      const inner = v.replace(/^\{/, "").replace(/\}$/, "");
      return inner === "" ? [] : inner.split(",");
    };
    const byRole = Object.fromEntries(
      rows.map((r) => [r.rolname, parseArrayLiteral(r.privileges)]),
    );
    expect(byRole["anon"]).toEqual([]);
    expect(byRole["authenticated"]).toEqual([]);
    expect(byRole["service_role"]).toEqual(["SELECT"]);

    // RLS is on (deny-by-default; service_role bypasses by design).
    const { rows: rls } = await q<{ relrowsecurity: boolean }>(
      `select relrowsecurity from pg_class where oid = 'public.account_conversion_snapshots'::regclass`,
    );
    expect(rls[0]!.relrowsecurity).toBe(true);
  });

  it("M11: function ACLs — leaderboard and record_match_completion are service-role-only; trigger function is not executable by PUBLIC", async () => {
    const { rows } = await q<{ proname: string; acl: string[] | null }>(
      `select p.proname, p.proacl::text[] as acl
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in (
            'leaderboard_page_v1',
            'leaderboard_page_v2',
            'record_match_completion_v1',
            'capture_account_conversion_snapshot'
          )`,
    );
    const byName = Object.fromEntries(rows.map((r) => [r.proname, r.acl]));
    for (const name of [
      "leaderboard_page_v1",
      "leaderboard_page_v2",
      "record_match_completion_v1",
      "capture_account_conversion_snapshot",
    ]) {
      const acl = byName[name];
      // proacl NULL means the DEFAULT privileges apply — PUBLIC EXECUTE
      // included. Every function in this migration revokes that, so a null
      // ACL is itself a failure: a removed revoke would otherwise pass the
      // itemized checks below while silently restoring PUBLIC EXECUTE.
      expect(acl, `${name} must have an explicit ACL (null means default PUBLIC EXECUTE)`).not.toBeNull();
      const entries = acl!;
      // No PUBLIC execute, and nothing for the publishable-key roles.
      expect(entries.some((e) => e.startsWith("="))).toBe(false);
      expect(entries.some((e) => e.startsWith("anon="))).toBe(false);
      expect(entries.some((e) => e.startsWith("authenticated="))).toBe(false);
    }
    const aclOf = (n: string) => byName[n]!;
    expect(aclOf("leaderboard_page_v1").some((e) => e.startsWith("service_role=X"))).toBe(true);
    expect(aclOf("leaderboard_page_v2").some((e) => e.startsWith("service_role=X"))).toBe(true);
    expect(aclOf("record_match_completion_v1").some((e) => e.startsWith("service_role=X"))).toBe(true);

    // Defence in depth, runtime level: as anon the RPC is not callable.
    // (ACL assertions above are the primary check; pg has no cheap way to
    // SET ROLE from a pooled superuser connection without side effects, so
    // the catalog check is authoritative here.)
  });

  it("M12: trigger definition — AFTER UPDATE OF is_anonymous with the exact true->false WHEN clause, SECURITY DEFINER, pinned search_path", async () => {
    const { rows: trg } = await q<{ tgname: string; definition: string }>(
      `select t.tgname, pg_get_triggerdef(t.oid) as definition
       from pg_trigger t
       where t.tgrelid = 'auth.users'::regclass
         and t.tgname = 'on_auth_user_converted_capture_snapshot'
         and not t.tgisinternal`,
    );
    expect(trg).toHaveLength(1);
    expect(trg[0]!.definition).toContain("AFTER UPDATE OF is_anonymous");
    // pg_get_triggerdef deparses with parentheses and lowercase: assert
    // case-insensitively against the deparsed form.
    expect(trg[0]!.definition.toLowerCase()).toContain(
      "old.is_anonymous is true) and (new.is_anonymous is false",
    );

    const { rows: fn } = await q<{ prosecdef: boolean; config: string[] }>(
      `select p.prosecdef, p.proconfig as config
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'capture_account_conversion_snapshot'`,
    );
    expect(fn[0]!.prosecdef).toBe(true);
    // proconfig renders the blank pinned path as 'search_path=""'.
    expect(fn[0]!.config).toContain('search_path=""');
  });

  it("M13: the K-boundary one-human-seat-per-match assumption is pinned — a second human seat in one match visibly advances match_number twice", async () => {
    // The rating SQL advances the K boundary per human seat ROW. Today's
    // modes have exactly one human seat per match, so row order coincides
    // with match order. This test PINS that assumption: if a future
    // multi-human mode ever persists a second human seat per match, this
    // test's explicit demonstration is the documentation that the formula
    // (and packages/ranking parity) must be revisited — see the LATENT
    // ASSUMPTION comments in the migration.
    const user = await createUser(false);
    cleanupUsers.push(user);
    // 20 matches with utility +0.25 (K=32 each under per-match counting),
    // then match 21 carries TWO human seat rows for the same user at
    // utility -0.5. Per-match counting would apply K=16 once; per-row
    // counting (today's implementation) applies K=16 to BOTH rows.
    for (let i = 0; i < 20; i++) {
      const matchId = mid(`m13-${i}`);
      cleanupMatches.push(matchId);
      await insertMatch(matchId, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), [
        humanSeat("seat1", user, 0.25, 100),
        agentSeat("seat2", 0, 0),
        agentSeat("seat3", 0, 0),
        agentSeat("seat4", 0, 0),
      ]);
    }
    const doubleSeatMatch = mid("m13-double");
    cleanupMatches.push(doubleSeatMatch);
    await insertMatch(doubleSeatMatch, new Date(Date.UTC(2026, 0, 1, 1, 0)).toISOString(), [
      humanSeat("seat1", user, -0.5, 100),
      humanSeat("seat2", user, -0.5, 100), // second human seat: hypothetical multi-human mode
      agentSeat("seat3", 0, 0),
      agentSeat("seat4", 0, 0),
    ]);

    const { rows } = await q<{ appraiser_rating: number; matches_played: string }>(
      `select appraiser_rating, matches_played from public.leaderboard_page_v1(0, 100) where user_id = $1`,
      [user],
    );
    expect(rows).toHaveLength(1);
    // Per-row counting: 1000 + 20*32*0.25 + 2*16*(-0.5) = 1144.
    // Per-match counting would give 1000 + 20*32*0.25 + 16*(-0.5) = 1152.
    // Today's implementation produces 1144 — if a future schema change
    // makes this test fail with 1152 (or anything else), the boundary
    // semantics changed and the packages/ranking contract MUST be
    // re-negotiated, not silently reinterpreted.
    expect(rows[0]!.appraiser_rating).toBeCloseTo(1144, 9);
    // matches_played counts DISTINCT matches even with two seat rows.
    expect(Number(rows[0]!.matches_played)).toBe(21);
  });

  it("M14: leaderboard_page_v2 equals packages/ranking pocketBalance / winLossRecord over the same rows, including a push and a loss", async () => {
    // Mandatory THE-60 contract: the SQL pocket is the algebraic equivalent
    // of packages/ranking. Real production data already contains a push
    // (realized_profit = 0 on the no-sale path); this is not hypothetical.
    const user = await createUser(false);
    cleanupUsers.push(user);
    const matches = [
      { profit: 74_150 }, // win
      { profit: 0 }, // push
      { profit: -12_000 }, // loss
    ];
    for (let i = 0; i < matches.length; i++) {
      const matchId = mid(`m14-${i}`);
      cleanupMatches.push(matchId);
      await insertMatch(matchId, new Date(Date.UTC(2026, 7, 17, 0, i)).toISOString(), [
        humanSeat("seat1", user, 0, matches[i]!.profit),
        agentSeat("seat2", 0, 0),
        agentSeat("seat3", 0, 0),
        agentSeat("seat4", 0, 0),
      ]);
    }

    const { rows } = await q<{
      user_id: string;
      matches_played: string;
      wins: string;
      losses: string;
      pushes: string;
      pocket_balance: string;
      rank: string;
      total: string;
    }>(`select * from public.leaderboard_page_v2(0, 100) where user_id = $1`, [user]);

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    const expectedRecord = referenceWinLoss(matches);
    expect(Number(row.matches_played)).toBe(3);
    expect(Number(row.pocket_balance)).toBeCloseTo(referencePocket(matches), 6);
    expect(Number(row.pocket_balance)).toBe(POCKET_OPENING_BALANCE + 74_150 - 12_000);
    expect(Number(row.wins)).toBe(expectedRecord.wins);
    expect(Number(row.losses)).toBe(expectedRecord.losses);
    expect(Number(row.pushes)).toBe(expectedRecord.pushes);
    expect(Number(row.wins)).toBe(1);
    expect(Number(row.losses)).toBe(1);
    expect(Number(row.pushes)).toBe(1);
  });

  it("M15: leaderboard_page_v2 orders by pocket desc, wins desc, matches_played asc, user_id asc; guests are excluded; pagination is stable", async () => {
    const [rich, samePocketMoreWins, samePocketMoreMatches, guest] = await Promise.all([
      createUser(false),
      createUser(false),
      createUser(false),
      createUser(true),
    ]);
    cleanupUsers.push(rich, samePocketMoreWins, samePocketMoreMatches, guest);

    // Rich: one large win. Highest pocket, ranks first regardless of wins.
    const richMatch = mid("m15-rich");
    cleanupMatches.push(richMatch);
    await insertMatch(richMatch, new Date(Date.UTC(2026, 7, 17, 1, 0)).toISOString(), [
      humanSeat("seat1", rich, 0, 200_000),
      agentSeat("seat2", 0, 0),
      agentSeat("seat3", 0, 0),
      agentSeat("seat4", 0, 0),
    ]);

    // Two wins of 50k: same pocket as the next user, more wins → ranks higher.
    for (let i = 0; i < 2; i++) {
      const matchId = mid(`m15-wins-${i}`);
      cleanupMatches.push(matchId);
      await insertMatch(matchId, new Date(Date.UTC(2026, 7, 17, 2, i)).toISOString(), [
        humanSeat("seat1", samePocketMoreWins, 0, 50_000),
        agentSeat("seat2", 0, 0),
        agentSeat("seat3", 0, 0),
        agentSeat("seat4", 0, 0),
      ]);
    }

    // One 100k win plus a push: same pocket and wins as a one-win player
    // would have, but more matches → ranks lower than a one-match 100k win.
    // We already used the two-win user for the wins tie-break, so this
    // player is the matches_played tail against... we need a one-match
    // 100k sibling. samePocketMoreWins is 2_100_000 with 2 wins; this
    // user is also 2_100_000 with 1 win + 1 push, so fewer wins → last
    // of the 2_100_000 cohort.
    const hundred = mid("m15-matches-win");
    const push = mid("m15-matches-push");
    cleanupMatches.push(hundred, push);
    await insertMatch(hundred, new Date(Date.UTC(2026, 7, 17, 3, 0)).toISOString(), [
      humanSeat("seat1", samePocketMoreMatches, 0, 100_000),
      agentSeat("seat2", 0, 0),
      agentSeat("seat3", 0, 0),
      agentSeat("seat4", 0, 0),
    ]);
    await insertMatch(push, new Date(Date.UTC(2026, 7, 17, 3, 1)).toISOString(), [
      humanSeat("seat1", samePocketMoreMatches, 0, 0),
      agentSeat("seat2", 0, 0),
      agentSeat("seat3", 0, 0),
      agentSeat("seat4", 0, 0),
    ]);

    // Guest with a huge pocket — must never appear.
    const guestMatch = mid("m15-guest");
    cleanupMatches.push(guestMatch);
    await insertMatch(guestMatch, new Date(Date.UTC(2026, 7, 17, 4, 0)).toISOString(), [
      humanSeat("seat1", guest, 0, 9_000_000),
      agentSeat("seat2", 0, 0),
      agentSeat("seat3", 0, 0),
      agentSeat("seat4", 0, 0),
    ]);

    const { rows: page } = await q<{
      user_id: string;
      pocket_balance: string;
      wins: string;
      matches_played: string;
      rank: string;
      total: string;
    }>(`select * from public.leaderboard_page_v2(0, 100)`);

    const ids = page.map((r) => r.user_id);
    expect(ids).toContain(rich);
    expect(ids).toContain(samePocketMoreWins);
    expect(ids).toContain(samePocketMoreMatches);
    expect(ids).not.toContain(guest);

    const richRow = page.find((r) => r.user_id === rich)!;
    const moreWinsRow = page.find((r) => r.user_id === samePocketMoreWins)!;
    const moreMatchesRow = page.find((r) => r.user_id === samePocketMoreMatches)!;
    expect(Number(richRow.pocket_balance)).toBe(POCKET_OPENING_BALANCE + 200_000);
    expect(Number(moreWinsRow.pocket_balance)).toBe(POCKET_OPENING_BALANCE + 100_000);
    expect(Number(moreMatchesRow.pocket_balance)).toBe(POCKET_OPENING_BALANCE + 100_000);
    expect(Number(moreWinsRow.wins)).toBe(2);
    expect(Number(moreMatchesRow.wins)).toBe(1);
    expect(Number(moreWinsRow.matches_played)).toBe(2);
    expect(Number(moreMatchesRow.matches_played)).toBe(2);
    expect(Number(richRow.rank)).toBeLessThan(Number(moreWinsRow.rank));
    expect(Number(moreWinsRow.rank)).toBeLessThan(Number(moreMatchesRow.rank));

    const { rows: page2 } = await q<(typeof page)[number]>(
      `select * from public.leaderboard_page_v2(1, 1)`,
    );
    expect(page2).toHaveLength(1);
    expect(Number(page2[0]!.rank)).toBe(2);
    expect(Number(page2[0]!.total)).toBe(Number(richRow.total));
  });

  it("M16: a second human seat in one match is counted as a row for wins/losses/pushes but not as a second match", async () => {
    // Pins the same latent assumption M13 pins for rating: today's SQL
    // counts W/L/P per human seat ROW. If a future multi-human mode
    // persists two human seats per match, this demonstration is the
    // documentation that the formula (and packages/ranking parity) must
    // be revisited — see the LATENT ASSUMPTION comments in the migration.
    const user = await createUser(false);
    cleanupUsers.push(user);
    const matchId = mid("m16-double");
    cleanupMatches.push(matchId);
    await insertMatch(matchId, new Date(Date.UTC(2026, 7, 17, 5, 0)).toISOString(), [
      humanSeat("seat1", user, 0, 100),
      humanSeat("seat2", user, 0, -40),
      agentSeat("seat3", 0, 0),
      agentSeat("seat4", 0, 0),
    ]);

    const { rows } = await q<{
      matches_played: string;
      wins: string;
      losses: string;
      pushes: string;
      pocket_balance: string;
    }>(`select * from public.leaderboard_page_v2(0, 100) where user_id = $1`, [user]);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.matches_played)).toBe(1);
    expect(Number(rows[0]!.wins)).toBe(1);
    expect(Number(rows[0]!.losses)).toBe(1);
    expect(Number(rows[0]!.pushes)).toBe(0);
    expect(Number(rows[0]!.pocket_balance)).toBe(POCKET_OPENING_BALANCE + 60);
  });

  it("M17: leaderboard_page_v1 is still present (deploy-ordering retain)", async () => {
    const { rows } = await q<{ proname: string }>(
      `select p.proname
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'leaderboard_page_v1'`,
    );
    expect(rows).toHaveLength(1);
    // Callable: the running production server still uses v1 until the
    // server deploy that switches to v2.
    const { rows: page } = await q(`select * from public.leaderboard_page_v1(0, 1)`);
    expect(Array.isArray(page)).toBe(true);
  });
});
