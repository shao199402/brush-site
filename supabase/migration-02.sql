-- ══════════════════════════════════════════════════════════════════
-- 迁移 02：人民币折算 + 新订单邮件通知
--
-- 用法：Supabase SQL Editor 整段粘贴执行（或用管理 API 调用）
--
-- 包含：
--   1. orders 增加 total_cny 列（统一人民币金额，便于后台排序/统计）
--   2. submit_order 支持 total_cny 与每个商品的来源页（page）
--   3. 新订单触发器：用 pg_net 调邮件服务（Resend）发通知给管理员
-- ══════════════════════════════════════════════════════════════════

-- ── 1. 新增人民币金额列 ─────────────────────────────────────
alter table public.orders
  add column if not exists total_cny numeric(12,2);

create index if not exists orders_total_cny_idx on public.orders (total_cny desc);

-- ── 2. 邮件相关配置（留空则不发信）──────────────────────────
insert into public.app_settings (key, value) values
  ('mail_provider', 'resend'),   -- 目前支持 resend
  ('mail_api_key', ''),          -- 去 https://resend.com 申请，填 re_ 开头的 key
  ('mail_from', 'orders@yourdomain.com'),  -- 必须是 Resend 已验证的发件域名
  ('mail_to', (select value from public.app_settings where key = 'admin_email'))
on conflict (key) do nothing;

-- 让 mail_to 跟随 admin_email（如果之前没设过）
update public.app_settings
   set value = (select value from public.app_settings where key = 'admin_email')
 where key = 'mail_to' and (value is null or value = '');

-- ── 3. 更新下单函数：接收 total_cny ─────────────────────────
create or replace function public.submit_order(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone    text := nullif(trim(payload->>'customer_phone'), '');
  v_name     text := nullif(trim(payload->>'customer_name'), '');
  v_address  text := nullif(trim(payload->>'customer_address'), '');
  v_order_no text := nullif(trim(payload->>'order_no'), '');
  v_total    numeric(12,2) := nullif(payload->>'total_cny', '')::numeric;
  v_recent   int;
begin
  if v_phone is null or v_name is null or v_address is null or v_order_no is null then
    return jsonb_build_object('ok', false, 'error', '缺少必填字段');
  end if;
  if length(v_address) < 5 or length(v_phone) < 5 then
    return jsonb_build_object('ok', false, 'error', '信息不完整');
  end if;

  select count(*) into v_recent
    from public.orders
   where customer_phone = v_phone
     and created_at > now() - interval '10 minutes';
  if v_recent >= 5 then
    return jsonb_build_object('ok', false, 'error', '提交过于频繁，请稍后再试或直接联系客服');
  end if;

  insert into public.orders (
    order_no, customer_name, customer_phone, customer_address, customer_note,
    items, subtotals, order_text, source_page, total_cny
  ) values (
    v_order_no, v_name, v_phone, v_address, nullif(trim(payload->>'customer_note'), ''),
    coalesce(payload->'items', '[]'::jsonb),
    coalesce(payload->'subtotals', '{}'::jsonb),
    nullif(payload->>'order_text', ''),
    nullif(payload->>'source_page', ''),
    v_total
  );

  return jsonb_build_object('ok', true, 'order_no', v_order_no);
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'error', '订单号重复，请重试');
end;
$$;

revoke all on function public.submit_order(jsonb) from public;
grant execute on function public.submit_order(jsonb) to anon, authenticated;

-- ── 4. 新订单邮件通知 ───────────────────────────────────────
create or replace function public.notify_new_order()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key   text := coalesce((select value from public.app_settings where key = 'mail_api_key'), '');
  v_from  text := coalesce((select value from public.app_settings where key = 'mail_from'), '');
  v_to    text := coalesce((select value from public.app_settings where key = 'mail_to'), '');
  v_items text := '';
  v_subs  text := '';
  v_html  text;
  v_cny   text;
  it      jsonb;
  kv      record;
begin
  -- 没配 key 就静默跳过（不影响下单）
  if v_key = '' or v_to = '' or v_from = '' then
    return NEW;
  end if;

  -- 商品清单
  for it in select * from jsonb_array_elements(coalesce(NEW.items, '[]'::jsonb)) loop
    v_items := v_items || format(
      '• %s ×%s（%s %s）<br/>',
      coalesce(it->>'title', '—'),
      coalesce(it->>'qty', '1'),
      coalesce(it->>'currency', ''),
      coalesce(it->>'amount', '')
    );
  end loop;

  -- 分币种小计
  for kv in select key, value from jsonb_each_text(coalesce(NEW.subtotals, '{}'::jsonb)) loop
    v_subs := v_subs || format('%s %s　', kv.key, kv.value);
  end loop;

  v_cny := case when NEW.total_cny is null then '—'
                else '¥' || to_char(NEW.total_cny, 'FM999,999,990.00') end;

  v_html :=
    '<h2 style="margin:0 0 12px">新订单 ' || NEW.order_no || '</h2>'
    || '<p style="font-size:15px;margin:0 0 16px">'
    || '下单人：<b>' || coalesce(NEW.customer_name, '') || '</b>　'
    || '电话：<b>' || coalesce(NEW.customer_phone, '') || '</b><br/>'
    || '地址：' || coalesce(NEW.customer_address, '') || '<br/>'
    || case when coalesce(NEW.customer_note, '') <> ''
         then '备注：' || NEW.customer_note || '<br/>' else '' end
    || '</p>'
    || '<p style="font-size:20px;margin:0 0 16px;color:#e03115">合计：<b>' || v_cny || '</b></p>'
    || '<p style="margin:0 0 4px;color:#666">' || v_subs || '</p>'
    || '<p style="margin:12px 0 4px"><b>商品</b></p>'
    || '<p style="margin:0;line-height:1.7">' || v_items || '</p>'
    || '<p style="margin-top:18px;color:#999;font-size:12px">'
    || '订单号 ' || NEW.order_no || '　来源页 ' || coalesce(NEW.source_page, '—')
    || '　时间 ' || to_char(NEW.created_at, 'YYYY-MM-DD HH24:MI:SS') || '</p>';

  perform net.http_post(
    url := 'https://api.resend.com/emails',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_key,
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object(
      'from', v_from,
      'to', jsonb_build_array(v_to),
      'subject', '【新订单】' || NEW.order_no || ' · ' || coalesce(NEW.customer_name, '') || ' · ' || v_cny,
      'html', v_html
    ),
    timeout_milliseconds := 10000
  );

  return NEW;
exception
  when others then
    -- 发信失败绝不影响订单入库
    raise warning 'notify_new_order failed: %', sqlerrm;
    return NEW;
end;
$$;

drop trigger if exists on_order_created on public.orders;
create trigger on_order_created
  after insert on public.orders
  for each row execute function public.notify_new_order();

-- ── 5. 自检 ─────────────────────────────────────────────────
-- select column_name from information_schema.columns where table_name='orders' and column_name='total_cny';
-- select key, value from public.app_settings order by key;
-- select tgname from pg_trigger where tgname = 'on_order_created';
