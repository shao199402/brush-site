-- ═══════════════════════════════════════════════════════════════════
-- 迁移 05：下单校验的提示更明确
--
-- 背景：原来的报错是笼统的「信息不完整」，
--       客户看到这句话完全不知道是哪个字段的问题，
--       而且前端把「服务器拒绝」误当成「网络失败」，
--       直接显示「订单已生成」，导致客户以为下单成功、实际没进库。
--
-- 本迁移只改提示文案和校验粒度，逻辑不变。
-- ═══════════════════════════════════════════════════════════════════

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
  -- 逐项校验，明确指出是哪一项不合格
  if v_name is null then
    return jsonb_build_object('ok', false, 'error', '请填写收货人姓名');
  end if;
  if v_phone is null then
    return jsonb_build_object('ok', false, 'error', '请填写联系电话');
  end if;
  if length(v_phone) < 5 then
    return jsonb_build_object('ok', false, 'error', '联系电话太短，请填写完整的手机号或微信号');
  end if;
  if v_address is null then
    return jsonb_build_object('ok', false, 'error', '请填写收货地址');
  end if;
  if length(v_address) < 5 then
    return jsonb_build_object('ok', false, 'error', '收货地址太短，请填写省市区和详细地址');
  end if;
  if v_order_no is null then
    return jsonb_build_object('ok', false, 'error', '订单号生成失败，请刷新页面重试');
  end if;

  -- 限流：同一手机号 10 分钟内最多 5 单
  select count(*) into v_recent
    from public.orders
   where customer_phone = v_phone
     and created_at > now() - interval '10 minutes';
  if v_recent >= 5 then
    return jsonb_build_object('ok', false, 'error', '同一号码提交过于频繁，请 10 分钟后再试，或直接加微信联系');
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
    return jsonb_build_object('ok', false, 'error', '订单号重复，请重新提交');
  when others then
    return jsonb_build_object('ok', false, 'error', '系统错误：' || sqlerrm);
end;
$$;
