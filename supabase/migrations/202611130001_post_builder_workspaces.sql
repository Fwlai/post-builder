create extension if not exists pgcrypto;

create table if not exists public.post_builder_channels (
  id uuid primary key default gen_random_uuid(),
  owner_user_id bigint not null,
  chat_id bigint not null,
  username text,
  title text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_user_id, chat_id)
);

create index if not exists post_builder_channels_owner_idx
  on public.post_builder_channels (owner_user_id, created_at desc);

create table if not exists public.post_builder_drafts (
  id uuid primary key default gen_random_uuid(),
  owner_user_id bigint not null unique,
  draft_type text not null check (draft_type in ('post', 'post2', 'post3')),
  stage text not null,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.post_builder_channels enable row level security;
alter table public.post_builder_drafts enable row level security;

-- The bot accesses these tables only from the server with the Supabase
-- service-role key. No client-side/anon access is granted.
