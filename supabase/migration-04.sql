-- ═══════════════════════════════════════════════════════════════════
-- 迁移 04：系统管理员 + 只读人员
--
-- 角色只有两种，不做更细的权限矩阵：
--   admin  系统管理员：看订单、改状态、导出、新增/停用人员
--   viewer 只读人员  ：只能看订单列表（不能改状态、不能进人员管理）
--
-- 要点：
--   1. 用 staff 表记录成员；订单策略改为「是否是 active 的 staff」
--   2. 判断成员身份的函数是 SECURITY DEFINER，避免 staff 表的策略递归引用自己
--   3. 新增人员由 create_staff() 完成：同时写 auth.users + auth.identities + staff
--      （浏览器端没有 service_role key，无法调 Auth Admin API，只能用 RPC 代劳）
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. 成员表 ────────────────────────────────────────────────
create table if not exists public.staff (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid unique references auth.users(id) on delete cascade,
  email       text not null unique,
  name        text,
  role        text not null default 'viewer' check (role in ('admin', 'viewer')),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  created_by  text
);

create index if not exists staff_email_idx on public.staff (lower(email));

-- ── 2. 身份判断函数（SECURITY DEFINER，绕过 RLS 自身递归）────
create or replace function public.is_staff()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.staff
     where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
       and active
  );
$$;

create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.staff
     where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
       and active
       and role = 'admin'
  );
$$;

grant execute on function public.is_staff() to authenticated;
grant execute on function public.is_admin() to authenticated;

-- ── 3. 订单策略改为基于 staff ────────────────────────────────
drop policy if exists "admin read orders"   on public.orders;
drop policy if exists "admin update orders" on public.orders;

-- 所有在职成员（含只读）都能看订单
create policy "staff read orders" on public.orders
  for select to authenticated
  using (public.is_staff());

-- 只有管理员能改订单
create policy "admin update orders" on public.orders
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ── 4. staff 表自己的策略 ───────────────────────────────────
alter table public.staff enable row level security;

drop policy if exists "staff read staff"   on public.staff;
drop policy if exists "admin write staff"  on public.staff;

-- 成员能看到成员列表（页面上要判断自己是不是管理员）
create policy "staff read staff" on public.staff
  for select to authenticated
  using (public.is_staff());

-- 只有管理员能改（新增走 RPC，这里主要给启停用/改角色）
create policy "admin write staff" on public.staff
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "admin delete staff" on public.staff
  for delete to authenticated
  using (public.is_admin());

-- ── 5. 新增人员 RPC ─────────────────────────────────────────
create or replace function public.create_staff(
  p_email    text,
  p_password text,
  p_name     text default '',
  p_role     text default 'viewer'
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  v_email text := lower(trim(p_email));
  v_uid   uuid := gen_random_uuid();
begin
  if not public.is_admin() then
    return jsonb_build_object('ok', false, 'error', '只有系统管理员可以新增人员');
  end if;
  if v_email is null or v_email = '' or position('@' in v_email) = 0 then
    return jsonb_build_object('ok', false, 'error', '邮箱格式不对');
  end if;
  if length(coalesce(p_password, '')) < 6 then
    return jsonb_build_object('ok', false, 'error', '密码至少 6 位');
  end if;
  if p_role not in ('admin', 'viewer') then
    return jsonb_build_object('ok', false, 'error', '角色只能是 admin 或 viewer');
  end if;
  if exists (select 1 from auth.users where lower(email) = v_email) then
    return jsonb_build_object('ok', false, 'error', '这个邮箱已经存在');
  end if;

  -- auth.users
  -- ⚠ token 类列必须是**空字符串**，不能是 NULL。
  --   填 NULL 时密码登录会报 "Database error querying schema"（GoTrue 读这些列时假设非空）。
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at,
    raw_app_meta_data, raw_user_meta_data,
    confirmation_token, recovery_token, email_change, email_change_token_new,
    email_change_token_current, reauthentication_token,
    phone_change, phone_change_token, email_change_confirm_status
  ) values (
    '00000000-0000-0000-0000-000000000000', v_uid, 'authenticated', 'authenticated',
    v_email, extensions.crypt(p_password, extensions.gen_salt('bf')),
    now(), now(), now(),
    jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email')),
    jsonb_build_object('name', coalesce(p_name, '')),
    '', '', '', '',
    '', '',
    '', '', 0
  );

  -- auth.identities（缺这条就无法用邮箱密码登录）
  -- ⚠ email 列是 GENERATED ALWAYS AS (identity_data->>'email') STORED，
  --    不能显式插入，否则报 "cannot insert a non-DEFAULT value into column email"
  insert into auth.identities (
    id, provider_id, user_id, identity_data, provider,
    last_sign_in_at, created_at, updated_at
  ) values (
    gen_random_uuid(), v_uid::text, v_uid,
    jsonb_build_object('sub', v_uid::text, 'email', v_email, 'email_verified', true),
    'email', now(), now(), now()
  );

  -- staff
  insert into public.staff (user_id, email, name, role, created_by)
  values (v_uid, v_email, coalesce(nullif(trim(p_name), ''), split_part(v_email, '@', 1)),
          p_role, auth.jwt() ->> 'email');

  return jsonb_build_object('ok', true, 'user_id', v_uid, 'email', v_email, 'role', p_role);
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'error', '邮箱已存在');
  when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;

revoke all on function public.create_staff(text, text, text, text) from public;
grant execute on function public.create_staff(text, text, text, text) to authenticated;

-- ── 6. 把现有管理员登记为「系统管理员」──────────────────────
insert into public.staff (user_id, email, name, role, active, created_by)
select u.id, lower(u.email), '系统管理员', 'admin', true, 'system'
  from auth.users u
 where u.email is not null
on conflict (email) do update
  set role = 'admin', active = true, user_id = excluded.user_id;

-- ── 7. 自检 ─────────────────────────────────────────────────
-- select email, name, role, active from public.staff;
