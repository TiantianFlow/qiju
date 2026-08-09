-- THE-37b: durable match records and career statistics.
--
-- decisions baked in here:
-- * first completion wins: matches.match_id is the deterministic match
--   identifier (seed-<sha256(mode:seed)> for fixed seeds) and writes are
--   INSERT ... ON CONFLICT DO NOTHING, so a replayed seed can never
--   double-count.
-- * all-ai matches never touch career stats: match_seats.user_id is
--   NULLABLE and agent seats carry NULL, so "attribute economics to a
--   user" is enforceable in SQL (user_id is not null), not in app code.
-- * career is computed, not stored: no career_stats table; aggregates are
--   derived from these raw rows at query time.
-- * deny-by-default: RLS enabled, no policies. The server writes/reads
--   with the secret key, which bypasses RLS; the publishable key can
--   neither read nor write these tables.

create table if not exists public.matches (
  match_id text primary key,
  mode text not null check (mode in ('human-vs-ai', 'all-ai')),
  seed text not null,
  rule_bundle_id text not null,
  rule_manifest_hash text not null,
  content_hash text not null,
  final_state_hash text not null,
  created_at timestamptz not null default now(),
  completed_at timestamptz not null default now()
);

create table if not exists public.match_seats (
  id bigint generated always as identity primary key,
  match_id text not null references public.matches (match_id),
  seat_id text not null check (seat_id in ('seat1', 'seat2', 'seat3', 'seat4')),
  controller_kind text not null check (controller_kind in ('human', 'agent')),
  -- null for agent seats; the load-bearing column for decision 4.
  user_id uuid references auth.users (id),
  -- raw settlement fields exactly as the engine emits them (decision 1):
  -- persist raw data, never derived metrics, so formula changes later can
  -- recompute from raw rows.
  final_wealth numeric not null,
  realized_profit numeric not null,
  bonus_reward numeric not null,
  dense_economic_rank integer not null,
  utility_numerator numeric not null,
  utility_denominator numeric not null,
  -- agent seats must not carry a user; human seats must.
  check (
    (controller_kind = 'human' and user_id is not null)
    or (controller_kind = 'agent' and user_id is null)
  ),
  unique (match_id, seat_id)
);

create index if not exists match_seats_user_id_idx on public.match_seats (user_id)
  where user_id is not null;

alter table public.matches enable row level security;
alter table public.match_seats enable row level security;

-- The server reads/writes with the secret key, which PostgREST maps to the
-- service_role. Grant that role table privileges; RLS (above, with no
-- policies) still applies to every role that honours it — service_role
-- bypasses RLS by design, which is exactly the server-authoritative write
-- path. anon/authenticated get NO grants: the publishable key can neither
-- read nor write these tables (RLS + missing privileges, deny-by-default).
grant select, insert on public.matches to service_role;
grant select, insert on public.match_seats to service_role;
