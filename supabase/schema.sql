-- ============================================================
-- GemAI — Supabase schema
-- Run this in the Supabase SQL editor (Dashboard → SQL → New query).
--
-- Supabase is recommended over Neon for this project (see README):
--   • Built-in Auth (we use Anonymous Sign-ins → per-user RLS, zero login friction)
--   • Realtime + REST auto-generated from these tables
--   • Row-Level Security out of the box
--   • Free tier is generous and has no per-project "suspend when idle" issues
--
-- IMPORTANT: enable "Anonymous sign-ins" in Supabase → Authentication → Providers.
-- ============================================================

create extension if not exists pgcrypto;

-- ---- Long-term memory (facts about the user) ----
create table if not exists facts (
  id text primary key,
  user_id uuid not null default auth.uid(),
  text text not null,
  category text default 'fact',
  importance int default 1,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ---- Notebook ----
create table if not exists notes (
  id text primary key,
  user_id uuid not null default auth.uid(),
  text text,
  created_at timestamptz default now()
);

-- ---- Reminders ----
create table if not exists reminders (
  id text primary key,
  user_id uuid not null default auth.uid(),
  text text,
  at bigint,
  done boolean default false,
  created_at timestamptz default now()
);

-- ---- To-dos ----
create table if not exists todos (
  id text primary key,
  user_id uuid not null default auth.uid(),
  text text,
  done boolean default false,
  created_at timestamptz default now()
);

-- ---- Mood history ----
create table if not exists mood (
  id text primary key,
  user_id uuid not null default auth.uid(),
  emotion text,
  valence real,
  note text,
  ts bigint
);

-- ---- Goals (life / career / study / health / finance) ----
create table if not exists goals (
  id text primary key,
  user_id uuid not null default auth.uid(),
  text text,
  category text,
  done boolean default false,
  created_at timestamptz default now()
);

-- ---- Action / mission log (transparency) ----
create table if not exists action_log (
  id text primary key,
  user_id uuid not null default auth.uid(),
  action text,
  detail text,
  ts bigint
);

-- ---- Skills the AI has learned ----
create table if not exists skills (
  id text primary key,
  user_id uuid not null default auth.uid(),
  name text,
  text text,
  created_at timestamptz default now()
);

-- ---- Standing instructions / rules ----
create table if not exists instructions (
  id text primary key,
  user_id uuid not null default auth.uid(),
  text text,
  created_at timestamptz default now()
);

-- ---- Row-Level Security: each user can only touch their own rows ----
alter table facts enable row level security;
alter table notes enable row level security;
alter table reminders enable row level security;
alter table todos enable row level security;
alter table mood enable row level security;
alter table goals enable row level security;
alter table action_log enable row level security;
alter table skills enable row level security;
alter table instructions enable row level security;

create policy "own facts" on facts for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own notes" on notes for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own reminders" on reminders for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own todos" on todos for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own mood" on mood for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own goals" on goals for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own action_log" on action_log for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own skills" on skills for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own instructions" on instructions for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Optional: full-text search on facts for the search_memory tool
create index if not exists facts_text_idx on facts using gin (to_tsvector('simple', text));
