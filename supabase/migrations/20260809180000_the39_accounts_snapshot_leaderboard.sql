-- THE-39: guest->account conversion snapshot, leaderboard RPC, atomic match
-- writes, and hardened privileges.
--
-- decisions baked in here (binding: the-39-design.md + THE-39 Linear
-- design-acceptance comment):
-- * the conversion snapshot trigger fires on the exact state transition
--   auth.users.is_anonymous true -> false, NOT on auth.identities insert.
--   Identity inserts also fire for non-conversion events (second provider
--   on an already-permanent account) and correct filtering there would
--   depend on undocumented ordering between the identity insert and the
--   user update. The state transition carries OLD/NEW and is
--   ordering-independent.
-- * the snapshot FAILS CLOSED: any unexpected snapshot error aborts the
--   auth transaction. A conversion without its audit record violates
--   acceptance. This is deliberately the inverse of THE-37b match
--   persistence, which fails open so a database problem never breaks
--   gameplay.
-- * the leaderboard re-implements the Appraiser Rating formula
--   (INITIAL_RATING=1000, provisional K=32 for matches 1..20, established
--   K=16 from match 21) in SQL because PostgREST cannot join to
--   non-exposed auth.users nor express the window function. This is the
--   single leaderboard query, not a guest-filtering abstraction. The
--   mandatory contract test (the39 migration integration suite) compares
--   RPC output to packages/ranking updateAppraiserRating /
--   cumulativeRealizedProfit, including the 20/21 K boundary. If the
--   ranking formula ever changes, add a NEW versioned RPC + snapshot
--   version and an explicit recomputation decision; never silently edit
--   this SQL in place.

-- ---------------------------------------------------------------------------
-- 1. Conversion snapshot table (append-once: no updated_at, no update path).
-- ---------------------------------------------------------------------------
create table if not exists public.account_conversion_snapshots (
  user_id                     uuid primary key references auth.users (id) on delete cascade,
  converted_at                timestamptz not null,
  guest_created_at            timestamptz not null,
  snapshot_version            smallint not null,
  rating_formula_version      text not null,
  human_seat_rows             bigint not null,
  matches_played              bigint not null,
  appraiser_rating            double precision not null,
  cumulative_realized_profit  numeric not null,
  total_final_wealth          numeric not null,
  total_bonus_reward          numeric not null,
  best_dense_economic_rank    integer,
  rank_one_finishes           bigint not null,
  positive_profit_matches     bigint not null,
  first_match_completed_at    timestamptz,
  last_match_completed_at     timestamptz,
  source_max_match_seat_id    bigint
);

alter table public.account_conversion_snapshots enable row level security;

-- THE-40: deny-by-default, and the default-ACL grants Supabase attaches to
-- new public tables (ALL to anon/authenticated) are revoked, not merely
-- unused. The server reads snapshots with the secret key (service_role,
-- which bypasses RLS); the publishable key can neither read nor write.
-- The trigger function performs the insert as the migration owner
-- (SECURITY DEFINER), so service_role itself gets select only. Supabase's
-- default ACLs also hand service_role the full default set (TRUNCATE,
-- REFERENCES, TRIGGER included) on new public tables, so revoke ALL
-- before granting select — anything less leaves those grants in place.
revoke all on public.account_conversion_snapshots from anon, authenticated;
revoke all on public.account_conversion_snapshots from service_role;
grant select on public.account_conversion_snapshots to service_role;

-- ---------------------------------------------------------------------------
-- 2. Conversion snapshot trigger function (fail-closed, append-once).
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
    source_max_match_seat_id
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
      1000::double precision + coalesce(sum(
        (case when n.match_number <= 20 then 32 else 16 end)::double precision
        * n.utility_numerator::double precision
        / n.utility_denominator::double precision
      ), 0::double precision) as appraiser_rating
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
    1::smallint,
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
    (select max(s.id) from public.match_seats s where s.user_id = new.id)
  from career
  on conflict (user_id) do nothing;
  -- A conversion without its audit record must not exist: any unexpected
  -- error here propagates and aborts the auth transaction (fail-closed).
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Trigger: the conversion event is exactly is_anonymous true -> false.
-- ---------------------------------------------------------------------------
drop trigger if exists on_auth_user_converted_capture_snapshot on auth.users;
create trigger on_auth_user_converted_capture_snapshot
  after update of is_anonymous on auth.users
  for each row
  when (old.is_anonymous is true and new.is_anonymous is false)
  execute function public.capture_account_conversion_snapshot();

-- ---------------------------------------------------------------------------
-- 4. Leaderboard RPC: the single leaderboard query (service-role only).
--    Algebraic equivalent of packages/ranking:
--      INITIAL_RATING = 1000, PROVISIONAL_K = 32, ESTABLISHED_K = 16,
--      PROVISIONAL_MATCH_COUNT = 20.
--    The (m.completed_at, ms.match_id, ms.seat_id) ordering is load-bearing
--    at the K boundary: completed_at is database persistence time (the
--    ordering the durable source actually has); match_id/seat_id make ties
--    deterministic. Guests are excluded by the literal predicate
--    u.is_anonymous IS FALSE evaluated against authoritative auth.users at
--    query time — never the caller JWT, never RLS (service role bypasses
--    it). Sort: full-precision rating desc, cumulative profit desc, user_id
--    asc as the hidden deterministic tie-break. Rounding is display-only
--    and happens in the server, never here.
-- ---------------------------------------------------------------------------
create or replace function public.leaderboard_page_v1(p_offset integer, p_limit integer)
returns table (
  user_id uuid,
  matches_played bigint,
  cumulative_realized_profit numeric,
  appraiser_rating double precision,
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
      ms.seat_id,
      m.completed_at,
      ms.realized_profit,
      ms.utility_numerator,
      ms.utility_denominator,
      row_number() over (
        partition by ms.user_id
        order by m.completed_at, ms.match_id, ms.seat_id
      ) as match_number
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
      sum(eligible_rows.realized_profit) as cumulative_realized_profit,
      1000::double precision + sum(
        (case when eligible_rows.match_number <= 20 then 32 else 16 end)::double precision
        * eligible_rows.utility_numerator::double precision
        / eligible_rows.utility_denominator::double precision
      ) as appraiser_rating
    from eligible_rows
    group by eligible_rows.user_id
  ), ranked as (
    select
      scores.user_id,
      scores.matches_played,
      scores.cumulative_realized_profit,
      scores.appraiser_rating,
      row_number() over (
        order by scores.appraiser_rating desc,
                 scores.cumulative_realized_profit desc,
                 scores.user_id asc
      ) as rank,
      count(*) over () as total
    from scores
  )
  select
    ranked.user_id,
    ranked.matches_played,
    ranked.cumulative_realized_profit,
    ranked.appraiser_rating,
    ranked.rank,
    ranked.total
  from ranked
  order by ranked.appraiser_rating desc,
           ranked.cumulative_realized_profit desc,
           ranked.user_id asc
  offset p_offset
  limit p_limit;
$$;

revoke all on function public.leaderboard_page_v1(integer, integer) from public, anon, authenticated;
grant execute on function public.leaderboard_page_v1(integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 5. THE-43: atomic match completion write path. The old path upserted the
--    match row and then the seat rows as two independent statements, so
--    "first completion wins" was not guaranteed at the statement boundary
--    (a crash or a competing completion could leave a match row with
--    missing seats). This RPC performs match + all seat rows in ONE
--    transaction: the match row and every seat row either exist together
--    or not at all, and the ON CONFLICT DO NOTHING clauses preserve the
--    first-completion-wins rule for replayed deterministic match ids.
-- ---------------------------------------------------------------------------
create or replace function public.record_match_completion_v1(
  p_match_id text,
  p_mode text,
  p_seed text,
  p_rule_bundle_id text,
  p_rule_manifest_hash text,
  p_content_hash text,
  p_final_state_hash text,
  p_seats jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_mode not in ('human-vs-ai', 'all-ai') then
    raise exception 'invalid mode: %', p_mode;
  end if;
  if jsonb_typeof(p_seats) <> 'array' or jsonb_array_length(p_seats) = 0 then
    raise exception 'p_seats must be a non-empty json array';
  end if;

  -- First completion wins: a replayed deterministic id is a no-op, and it
  -- is a no-op for the whole unit — match and seats together.
  insert into public.matches (
    match_id, mode, seed, rule_bundle_id, rule_manifest_hash,
    content_hash, final_state_hash
  ) values (
    p_match_id, p_mode, p_seed, p_rule_bundle_id, p_rule_manifest_hash,
    p_content_hash, p_final_state_hash
  )
  on conflict (match_id) do nothing;

  insert into public.match_seats (
    match_id, seat_id, controller_kind, user_id,
    final_wealth, realized_profit, bonus_reward, dense_economic_rank,
    utility_numerator, utility_denominator
  )
  select
    p_match_id,
    seat->>'seat_id',
    seat->>'controller_kind',
    case
      when seat->>'controller_kind' = 'human'
        then (seat->>'user_id')::uuid
      else null
    end,
    (seat->>'final_wealth')::numeric,
    (seat->>'realized_profit')::numeric,
    (seat->>'bonus_reward')::numeric,
    (seat->>'dense_economic_rank')::integer,
    (seat->>'utility_numerator')::numeric,
    (seat->>'utility_denominator')::numeric
  from jsonb_array_elements(p_seats) as seat
  on conflict (match_id, seat_id) do nothing;
end;
$$;

revoke all on function public.record_match_completion_v1(
  text, text, text, text, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.record_match_completion_v1(
  text, text, text, text, text, text, text, jsonb
) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Validated denominator constraint: packages/ranking already rejects
--    non-positive denominators; the SQL rating path (snapshot + leaderboard)
--    must never be able to divide by invalid persisted input.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'match_seats_utility_denominator_positive'
      and conrelid = 'public.match_seats'::regclass
  ) then
    alter table public.match_seats
      add constraint match_seats_utility_denominator_positive
      check (utility_denominator > 0) not valid;
  end if;
end $$;
-- VALIDATE CONSTRAINT is a no-op when the constraint is already validated,
-- so this stays idempotent across a re-run or an interrupted earlier run.
alter table public.match_seats
  validate constraint match_seats_utility_denominator_positive;
