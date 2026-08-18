-- THE-60: pocket scoring model — versioned leaderboard RPC + snapshot v2.
--
-- Binding instruction from 20260809180000_the39_accounts_snapshot_leaderboard.sql:
-- "If the ranking formula ever changes, add a NEW versioned RPC + snapshot
-- version and an explicit recomputation decision; never silently edit this
-- SQL in place." This file follows that instruction exactly.
--
-- The live surface now ranks on one pocket per player:
--   pocket_balance = POCKET_OPENING_BALANCE + Σ realized_profit
--   wins   = count of human seat rows where realized_profit > 0
--   losses = count of human seat rows where realized_profit < 0
--   pushes = count of human seat rows where realized_profit = 0
-- Algebraic equivalent of packages/ranking/src/pocket.ts. The 2000000
-- literal below IS POCKET_OPENING_BALANCE in that file; the two must
-- change together. Duplication is deliberate: PostgREST cannot reach the
-- TS constant.
--
-- Recomputation decision: existing snapshot_version = 1 rows are NOT
-- rewritten. Pocket is derivable from match_seats at query time (THE-37b
-- persisted raw settlement, never derived metrics). The snapshot is an
-- immutable audit record — we add nullable columns and write version 2
-- on new conversions. Historical v1 rows keep pocket_balance / wins /
-- losses / pushes NULL. Appraiser Rating continues to be recorded on
-- the snapshot as an audit field; it leaves the live surface only.
--
-- leaderboard_page_v1 is retained. This is deploy ordering, not backward
-- compatibility: the running production server still calls v1, and this
-- migration lands before the server deploy. Dropping v1 is a follow-up.
--
-- Additive only. Idempotent. Safe against a live database.

-- ---------------------------------------------------------------------------
-- 1. Snapshot version 2 columns (nullable: v1 rows stay untouched).
-- ---------------------------------------------------------------------------
alter table public.account_conversion_snapshots
  add column if not exists pocket_balance numeric,
  add column if not exists wins bigint,
  add column if not exists losses bigint,
  add column if not exists pushes bigint;

-- ---------------------------------------------------------------------------
-- 2. Conversion snapshot trigger function — same fail-closed, append-once
--    contract as v1. New conversions write snapshot_version = 2 and
--    populate the pocket columns. Every existing column and the existing
--    appraiser-rating computation are preserved.
-- ---------------------------------------------------------------------------
create or replace function public.capture_account_conversion_snapshot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.account_conversion_snapshots (
    user_id,
    converted_at,
    guest_created_at,
    snapshot_version,
    rating_formula_version,
    human_seat_rows,
    matches_played,
    appraiser_rating,
    cumulative_realized_profit,
    total_final_wealth,
    total_bonus_reward,
    best_dense_economic_rank,
    rank_one_finishes,
    positive_profit_matches,
    first_match_completed_at,
    last_match_completed_at,
    source_max_match_seat_id,
    pocket_balance,
    wins,
    losses,
    pushes
  )
  with numbered as (
    -- match_number must be computed in its own query level: Postgres
    -- forbids window calls inside an aggregate at the same level.
    select
      ms.match_id,
      ms.realized_profit,
      ms.final_wealth,
      ms.bonus_reward,
      ms.dense_economic_rank,
      ms.utility_numerator,
      ms.utility_denominator,
      m.completed_at,
      row_number() over (
        order by m.completed_at, ms.match_id, ms.seat_id
      ) as match_number
    from public.match_seats ms
    join public.matches m on m.match_id = ms.match_id
    where ms.user_id = new.id
      and ms.controller_kind = 'human'
  ), career as (
    select
      count(*)::bigint as human_seat_rows,
      count(distinct n.match_id)::bigint as matches_played,
      coalesce(sum(n.realized_profit), 0::numeric) as cumulative_realized_profit,
      coalesce(sum(n.final_wealth), 0::numeric) as total_final_wealth,
      coalesce(sum(n.bonus_reward), 0::numeric) as total_bonus_reward,
      min(n.dense_economic_rank) as best_dense_economic_rank,
      count(*) filter (where n.dense_economic_rank = 1)::bigint as rank_one_finishes,
      count(distinct n.match_id) filter (where n.realized_profit > 0)::bigint as positive_profit_matches,
      min(n.completed_at) as first_match_completed_at,
      max(n.completed_at) as last_match_completed_at,
      -- the algebraic equivalent of folding updateAppraiserRating from
      -- packages/ranking: K=32 for matches 1..20, K=16 from match 21.
      -- LATENT ASSUMPTION (recorded, deliberately not restructured): the
      -- K boundary advances per HUMAN SEAT ROW, not per match. With
      -- today's modes exactly one human seat exists per match (seat1 in
      -- human-vs-ai; none in all-ai), so the two coincide. A future
      -- multi-human mode must revisit this formula AND its contract test
      -- (test M13 pins the assumption so such a mode fails loudly).
      1000::double precision + coalesce(sum(
        (case when n.match_number <= 20 then 32 else 16 end)::double precision
        * n.utility_numerator::double precision
        / n.utility_denominator::double precision
      ), 0::double precision) as appraiser_rating,
      -- 2000000 is POCKET_OPENING_BALANCE in packages/ranking/src/pocket.ts.
      -- The two must change together. Duplication is deliberate: PostgREST
      -- cannot reach the TS constant.
      2000000::numeric + coalesce(sum(n.realized_profit), 0::numeric) as pocket_balance,
      -- LATENT ASSUMPTION (recorded, deliberately not restructured):
      -- wins/losses/pushes count human seat ROWS, not distinct matches.
      -- Today's modes have exactly one human seat per match, so the two
      -- coincide. A future multi-human mode must revisit this (see
      -- leaderboard_page_v2 and test M14).
      count(*) filter (where n.realized_profit > 0)::bigint as wins,
      count(*) filter (where n.realized_profit < 0)::bigint as losses,
      count(*) filter (where n.realized_profit = 0)::bigint as pushes
    from numbered n
  )
  select
    new.id,
    now(),
    -- auth.users.created_at is nullable in some auth schema versions;
    -- a missing row timestamp is not a reason to break authentication
    -- writes (the snapshot must fail closed on real write errors, not on
    -- an absent informational column).
    coalesce(new.created_at, now()),
    2::smallint,
    'appraiser-v1',
    career.human_seat_rows,
    career.matches_played,
    career.appraiser_rating,
    career.cumulative_realized_profit,
    career.total_final_wealth,
    career.total_bonus_reward,
    career.best_dense_economic_rank,
    career.rank_one_finishes,
    career.positive_profit_matches,
    career.first_match_completed_at,
    career.last_match_completed_at,
    (select max(s.id) from public.match_seats s where s.user_id = new.id),
    career.pocket_balance,
    career.wins,
    career.losses,
    career.pushes
  from career
  on conflict (user_id) do nothing;
  -- A conversion without its audit record must not exist: any unexpected
  -- error here propagates and aborts the auth transaction (fail-closed).
  return new;
end;
$$;

-- CREATE OR REPLACE preserves privileges, but re-assert the v1 discipline
-- so a future default-ACL change cannot silently restore PUBLIC EXECUTE.
revoke all on function public.capture_account_conversion_snapshot() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Leaderboard RPC v2: the single leaderboard query (service-role only).
--    Algebraic equivalent of packages/ranking/src/pocket.ts.
--    Eligibility is the same predicate as v1: controller_kind = 'human',
--    user_id is not null, u.is_anonymous is false against authoritative
--    auth.users. Guests are excluded by that literal predicate at query
--    time — never the caller JWT, never RLS (service role bypasses it).
--    Sort (full tail is load-bearing for stable pagination):
--      pocket_balance desc, wins desc, matches_played asc, user_id asc.
-- ---------------------------------------------------------------------------
create or replace function public.leaderboard_page_v2(p_offset integer, p_limit integer)
returns table (
  user_id uuid,
  matches_played bigint,
  wins bigint,
  losses bigint,
  pushes bigint,
  pocket_balance numeric,
  rank bigint,
  total bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  with eligible_rows as (
    select
      ms.user_id,
      ms.match_id,
      ms.realized_profit
    from public.match_seats ms
    join public.matches m on m.match_id = ms.match_id
    join auth.users u on u.id = ms.user_id
    where ms.controller_kind = 'human'
      and ms.user_id is not null
      and u.is_anonymous is false
  ), scores as (
    select
      eligible_rows.user_id,
      count(distinct eligible_rows.match_id) as matches_played,
      -- LATENT ASSUMPTION (recorded, deliberately not restructured):
      -- wins/losses/pushes count human seat ROWS, not distinct matches.
      -- Today's modes have exactly one human seat per match, so row
      -- counts and match counts coincide; a future multi-human mode
      -- must rework this and its contract test (see M14).
      count(*) filter (where eligible_rows.realized_profit > 0) as wins,
      count(*) filter (where eligible_rows.realized_profit < 0) as losses,
      count(*) filter (where eligible_rows.realized_profit = 0) as pushes,
      -- 2000000 is POCKET_OPENING_BALANCE in packages/ranking/src/pocket.ts.
      -- The two must change together. Duplication is deliberate: PostgREST
      -- cannot reach the TS constant.
      2000000::numeric + coalesce(sum(eligible_rows.realized_profit), 0::numeric) as pocket_balance
    from eligible_rows
    group by eligible_rows.user_id
  ), ranked as (
    select
      scores.user_id,
      scores.matches_played,
      scores.wins,
      scores.losses,
      scores.pushes,
      scores.pocket_balance,
      row_number() over (
        order by scores.pocket_balance desc,
                 scores.wins desc,
                 scores.matches_played asc,
                 scores.user_id asc
      ) as rank,
      count(*) over () as total
    from scores
  )
  select
    ranked.user_id,
    ranked.matches_played,
    ranked.wins,
    ranked.losses,
    ranked.pushes,
    ranked.pocket_balance,
    ranked.rank,
    ranked.total
  from ranked
  order by ranked.pocket_balance desc,
           ranked.wins desc,
           ranked.matches_played asc,
           ranked.user_id asc
  offset p_offset
  limit p_limit;
$$;

revoke all on function public.leaderboard_page_v2(integer, integer) from public, anon, authenticated;
grant execute on function public.leaderboard_page_v2(integer, integer) to service_role;
