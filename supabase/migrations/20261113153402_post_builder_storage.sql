create extension if not exists pgcrypto;

create table if not exists public.post_builder_channels (
  id uuid primary key default gen_random_uuid(),
  owner_user_id text not null check (owner_user_id ~ '^[0-9]+$'),
  chat_id text not null,
  username text,
  title text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint post_builder_channels_owner_chat_unique unique (owner_user_id, chat_id)
);

create index if not exists post_builder_channels_owner_idx
  on public.post_builder_channels (owner_user_id, created_at desc);

create table if not exists public.post_builder_drafts (
  owner_user_id text primary key check (owner_user_id ~ '^[0-9]+$'),
  draft_type text not null check (draft_type in ('post', 'post2', 'post3')),
  stage text not null,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.post_builder_channels enable row level security;
alter table public.post_builder_drafts enable row level security;

revoke all on table public.post_builder_channels from public, anon, authenticated;
revoke all on table public.post_builder_drafts from public, anon, authenticated;

grant all on table public.post_builder_channels to service_role;
grant all on table public.post_builder_drafts to service_role;
