-- SECURITY UPGRADE (v2)
--
-- WARNING:
-- 1) This script drops and recreates `rooms` and `guesses`.
-- 2) Existing match data will be deleted.
-- 3) This version requires clients to use Supabase anonymous auth + RPC.

create extension if not exists pgcrypto;

drop table if exists public.guesses cascade;
drop table if exists public.rooms cascade;

create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  room_code text not null unique,
  word_length int not null check (word_length between 3 and 12),

  host_uid uuid not null,
  guest_uid uuid,

  host_name text not null,
  guest_name text,

  host_secret text,
  guest_secret text,

  host_secret_set boolean not null default false,
  guest_secret_set boolean not null default false,

  host_solved_attempt int,
  guest_solved_attempt int,

  status text not null default 'waiting' check (status in ('waiting', 'ready', 'playing', 'finished')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.guesses (
  id bigserial primary key,
  room_id uuid not null references public.rooms(id) on delete cascade,
  player_slot smallint not null check (player_slot in (1, 2)),
  guess text not null,
  marks jsonb not null,
  attempt_no int not null check (attempt_no > 0),
  created_at timestamptz not null default now()
);

create index idx_guesses_room_created
  on public.guesses(room_id, created_at);

create index idx_guesses_room_player
  on public.guesses(room_id, player_slot);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger trg_rooms_updated_at
before update on public.rooms
for each row
execute function public.set_updated_at();

create or replace function public.generate_room_code()
returns text
language plpgsql
as $$
declare
  chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  out_code text := '';
  i int;
begin
  for i in 1..6 loop
    out_code := out_code || substr(chars, 1 + floor(random() * length(chars))::int, 1);
  end loop;
  return out_code;
end;
$$;

create or replace function public.score_guess(p_guess text, p_target text)
returns text[]
language plpgsql
immutable
as $$
declare
  i int;
  v_len int := char_length(p_guess);
  g text;
  t text;
  cnt int;
  marks text[] := array_fill('absent'::text, array[v_len]);
  remaining jsonb := '{}'::jsonb;
begin
  for i in 1..v_len loop
    g := substr(p_guess, i, 1);
    t := substr(p_target, i, 1);

    if g = t then
      marks[i] := 'correct';
    else
      cnt := coalesce((remaining ->> t)::int, 0) + 1;
      remaining := jsonb_set(remaining, array[t], to_jsonb(cnt), true);
    end if;
  end loop;

  for i in 1..v_len loop
    if marks[i] = 'correct' then
      continue;
    end if;

    g := substr(p_guess, i, 1);
    cnt := coalesce((remaining ->> g)::int, 0);

    if cnt > 0 then
      marks[i] := 'present';
      remaining := jsonb_set(remaining, array[g], to_jsonb(cnt - 1), true);
    end if;
  end loop;

  return marks;
end;
$$;

create or replace function public.create_room(p_word_length int, p_host_name text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_code text;
  v_room_id uuid;
  v_name text := btrim(coalesce(p_host_name, ''));
begin
  if auth.uid() is null then
    raise exception '请先登录后再操作';
  end if;

  if p_word_length is null or p_word_length < 3 or p_word_length > 12 then
    raise exception '单词长度必须在 3 到 12 之间';
  end if;

  if char_length(v_name) = 0 then
    raise exception '昵称不能为空';
  end if;

  for i in 1..8 loop
    v_code := public.generate_room_code();

    begin
      insert into public.rooms (
        room_code,
        word_length,
        host_uid,
        host_name,
        status
      )
      values (
        v_code,
        p_word_length,
        auth.uid(),
        v_name,
        'waiting'
      )
      returning id into v_room_id;

      return jsonb_build_object(
        'room_id', v_room_id,
        'room_code', v_code,
        'role', 'host'
      );
    exception
      when unique_violation then
        continue;
    end;
  end loop;

  raise exception '创建房间失败，请重试';
end;
$$;

create or replace function public.join_room(p_room_code text, p_guest_name text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_code text := upper(btrim(coalesce(p_room_code, '')));
  v_name text := btrim(coalesce(p_guest_name, ''));
  v_room public.rooms%rowtype;
  v_role text;
begin
  if auth.uid() is null then
    raise exception '请先登录后再操作';
  end if;

  if char_length(v_code) = 0 then
    raise exception '房间码不能为空';
  end if;

  if char_length(v_name) = 0 then
    raise exception '昵称不能为空';
  end if;

  select *
  into v_room
  from public.rooms
  where room_code = v_code
  for update;

  if not found then
    raise exception '房间不存在：%', v_code;
  end if;

  if v_room.host_uid = auth.uid() then
    v_role := 'host';
    if v_room.host_name is distinct from v_name then
      update public.rooms set host_name = v_name where id = v_room.id;
    end if;
  elsif v_room.guest_uid is null then
    update public.rooms
    set
      guest_uid = auth.uid(),
      guest_name = v_name,
      status = case
        when host_secret_set and guest_secret_set then 'playing'
        else 'ready'
      end
    where id = v_room.id;

    v_role := 'guest';
  elsif v_room.guest_uid = auth.uid() then
    v_role := 'guest';
    if v_room.guest_name is distinct from v_name then
      update public.rooms set guest_name = v_name where id = v_room.id;
    end if;
  else
    raise exception '房间已满，请让对方重新创建';
  end if;

  select * into v_room from public.rooms where id = v_room.id;

  return jsonb_build_object(
    'room_id', v_room.id,
    'room_code', v_room.room_code,
    'role', v_role
  );
end;
$$;

create or replace function public.submit_secret(p_room_id uuid, p_secret text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_secret text := lower(btrim(coalesce(p_secret, '')));
  v_room public.rooms%rowtype;
  v_status text;
begin
  if v_uid is null then
    raise exception '请先登录后再操作';
  end if;

  select *
  into v_room
  from public.rooms
  where id = p_room_id
  for update;

  if not found then
    raise exception '房间不存在';
  end if;

  if v_uid <> v_room.host_uid and v_uid <> v_room.guest_uid then
    raise exception '你不在该房间中';
  end if;

  if v_secret !~ '^[a-z]+$' or char_length(v_secret) <> v_room.word_length then
    raise exception '秘密单词必须是 % 位英文字母', v_room.word_length;
  end if;

  if v_uid = v_room.host_uid then
    if v_room.host_secret_set then
      raise exception '你已经提交过秘密单词了';
    end if;

    update public.rooms
    set host_secret = v_secret,
        host_secret_set = true
    where id = v_room.id;
  else
    if v_room.guest_secret_set then
      raise exception '你已经提交过秘密单词了';
    end if;

    update public.rooms
    set guest_secret = v_secret,
        guest_secret_set = true
    where id = v_room.id;
  end if;

  update public.rooms
  set status = case
    when host_solved_attempt is not null and guest_solved_attempt is not null then 'finished'
    when host_secret_set and guest_secret_set then 'playing'
    when guest_uid is not null then 'ready'
    else 'waiting'
  end
  where id = v_room.id
  returning status into v_status;

  return jsonb_build_object(
    'ok', true,
    'status', v_status
  );
end;
$$;

create or replace function public.submit_guess(p_room_id uuid, p_guess text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_guess text := lower(btrim(coalesce(p_guess, '')));
  v_room public.rooms%rowtype;
  v_slot smallint;
  v_target text;
  v_attempt int;
  v_marks text[];
  v_solved boolean := false;
  v_status text;
begin
  if v_uid is null then
    raise exception '请先登录后再操作';
  end if;

  select *
  into v_room
  from public.rooms
  where id = p_room_id
  for update;

  if not found then
    raise exception '房间不存在';
  end if;

  if v_room.status = 'finished' then
    raise exception '本局已结束';
  end if;

  if v_guess !~ '^[a-z]+$' or char_length(v_guess) <> v_room.word_length then
    raise exception '猜词必须是 % 位英文字母', v_room.word_length;
  end if;

  if v_uid = v_room.host_uid then
    v_slot := 1;

    if v_room.host_solved_attempt is not null then
      raise exception '你已猜中，等待对方完成';
    end if;

    if not v_room.guest_secret_set or v_room.guest_secret is null then
      raise exception '对方还没提交秘密单词';
    end if;

    v_target := v_room.guest_secret;
  elsif v_uid = v_room.guest_uid then
    v_slot := 2;

    if v_room.guest_solved_attempt is not null then
      raise exception '你已猜中，等待对方完成';
    end if;

    if not v_room.host_secret_set or v_room.host_secret is null then
      raise exception '对方还没提交秘密单词';
    end if;

    v_target := v_room.host_secret;
  else
    raise exception '你不在该房间中';
  end if;

  select coalesce(max(attempt_no), 0) + 1
  into v_attempt
  from public.guesses
  where room_id = p_room_id and player_slot = v_slot;

  v_marks := public.score_guess(v_guess, v_target);

  insert into public.guesses (
    room_id,
    player_slot,
    guess,
    marks,
    attempt_no
  )
  values (
    p_room_id,
    v_slot,
    v_guess,
    to_jsonb(v_marks),
    v_attempt
  );

  v_solved := (v_guess = v_target);

  if v_solved then
    if v_slot = 1 then
      update public.rooms set host_solved_attempt = v_attempt where id = p_room_id;
    else
      update public.rooms set guest_solved_attempt = v_attempt where id = p_room_id;
    end if;
  end if;

  update public.rooms
  set status = case
    when host_solved_attempt is not null and guest_solved_attempt is not null then 'finished'
    when host_secret_set and guest_secret_set then 'playing'
    when guest_uid is not null then 'ready'
    else 'waiting'
  end
  where id = p_room_id
  returning status into v_status;

  return jsonb_build_object(
    'attempt_no', v_attempt,
    'marks', to_jsonb(v_marks),
    'solved', v_solved,
    'status', v_status
  );
end;
$$;

alter table public.rooms enable row level security;
alter table public.guesses enable row level security;

drop policy if exists rooms_select_member on public.rooms;
create policy rooms_select_member
on public.rooms
for select
to authenticated
using (auth.uid() = host_uid or auth.uid() = guest_uid);

drop policy if exists guesses_select_member on public.guesses;
create policy guesses_select_member
on public.guesses
for select
to authenticated
using (
  exists (
    select 1
    from public.rooms r
    where r.id = room_id
      and (r.host_uid = auth.uid() or r.guest_uid = auth.uid())
  )
);

revoke all on table public.rooms from anon, authenticated;
revoke all on table public.guesses from anon, authenticated;

grant usage on schema public to authenticated;

grant select (
  id,
  room_code,
  word_length,
  host_uid,
  guest_uid,
  host_name,
  guest_name,
  host_secret_set,
  guest_secret_set,
  host_solved_attempt,
  guest_solved_attempt,
  status,
  created_at,
  updated_at
) on public.rooms to authenticated;

grant select on table public.guesses to authenticated;

revoke select (host_secret, guest_secret)
on public.rooms
from anon, authenticated;

grant execute on function public.create_room(int, text) to authenticated;
grant execute on function public.join_room(text, text) to authenticated;
grant execute on function public.submit_secret(uuid, text) to authenticated;
grant execute on function public.submit_guess(uuid, text) to authenticated;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'rooms'
  ) then
    alter publication supabase_realtime add table public.rooms;
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'guesses'
  ) then
    alter publication supabase_realtime add table public.guesses;
  end if;
end;
$$;
