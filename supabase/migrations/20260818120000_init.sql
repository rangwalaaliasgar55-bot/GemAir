-- ============================================================
-- GemAir — initial schema (auto-applied by the Supabase GitHub integration)
--
-- Files in supabase/migrations/ with a timestamped name are applied
-- automatically when this branch merges into the production branch.
-- This file is idempotent: re-running it is always safe.
--
-- One manual step remains (it is an auth setting, not SQL):
--   Supabase → Authentication → Providers → enable "Anonymous sign-ins".
-- ============================================================

create extension if not exists pgcrypto;

-- ---- Long-term memory (facts about the user) ----
create table if not exists public.facts (
  id text primary key,
  user_id uuid not null default auth.uid(),
  text text not null,
  category text default 'fact',
  importance int default 1,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ---- Notebook ----
create table if not exists public.notes (
  id text primary key,
  user_id uuid not null default auth.uid(),
  text text,
  created_at timestamptz default now()
);

-- ---- Reminders ----
create table if not exists public.reminders (
  id text primary key,
  user_id uuid not null default auth.uid(),
  text text,
  at bigint,
  done boolean default false,
  created_at timestamptz default now()
);

-- ---- To-dos ----
create table if not exists public.todos (
  id text primary key,
  user_id uuid not null default auth.uid(),
  text text,
  done boolean default false,
  created_at timestamptz default now()
);

-- ---- Mood history ----
create table if not exists public.mood (
  id text primary key,
  user_id uuid not null default auth.uid(),
  emotion text,
  valence real,
  note text,
  ts bigint
);

-- ---- Goals (life / career / study / health / finance) ----
create table if not exists public.goals (
  id text primary key,
  user_id uuid not null default auth.uid(),
  text text,
  category text,
  done boolean default false,
  created_at timestamptz default now()
);

-- ---- Action / mission log (transparency) ----
create table if not exists public.action_log (
  id text primary key,
  user_id uuid not null default auth.uid(),
  action text,
  detail text,
  ts bigint
);

-- ---- Skills the AI has learned ----
create table if not exists public.skills (
  id text primary key,
  user_id uuid not null default auth.uid(),
  name text,
  text text,
  created_at timestamptz default now()
);

-- ---- Standing instructions / rules ----
create table if not exists public.instructions (
  id text primary key,
  user_id uuid not null default auth.uid(),
  text text,
  created_at timestamptz default now()
);

-- ---- Row-Level Security: each user can only touch their own rows ----
-- Loop keeps this short AND idempotent (drop-then-create avoids
-- "policy already exists", which would abort an auto-deploy).
do $$
declare
  t text;
  tables text[] := array[
    'facts', 'notes', 'reminders', 'todos', 'mood',
    'goals', 'action_log', 'skills', 'instructions'
  ];
begin
  foreach t in array tables loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "own rows" on public.%I', t);
    execute format(
      'create policy "own rows" on public.%I for all to authenticated
         using (auth.uid() = user_id) with check (auth.uid() = user_id)', t);
    -- index the owner column: every RLS check filters on it
    execute format('create index if not exists %I on public.%I (user_id)', t || '_user_id_idx', t);
  end loop;
end $$;

-- Drop the older per-table policy names from the pre-migration schema.sql,
-- so upgrading an existing project does not leave duplicates behind.
do $$
declare
  r record;
begin
  for r in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and policyname in (
        'own facts', 'own notes', 'own reminders', 'own todos', 'own mood',
        'own goals', 'own action_log', 'own skills', 'own instructions'
      )
  loop
    execute format('drop policy if exists %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

-- Full-text search on facts (used by the search_memory tool)
create index if not exists facts_text_idx
  on public.facts using gin (to_tsvector('simple', text));
