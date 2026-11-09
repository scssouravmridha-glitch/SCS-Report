-- SCS current live database only: run in Supabase SQL Editor after original schema.
-- This adds functions only, but the existing project has OPEN RLS; see README.
-- No data is modified by installing these functions.
create or replace function public.scs_export_snapshot()
returns jsonb language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'scs_manual_data', coalesce((select jsonb_agg(to_jsonb(t) order by month_key) from public.scs_manual_data t), '[]'::jsonb),
    'scs_manual_history', coalesce((select jsonb_agg(to_jsonb(t) order by id) from public.scs_manual_history t), '[]'::jsonb),
    'scs_orders', coalesce((select jsonb_agg(to_jsonb(t) order by id) from public.scs_orders t), '[]'::jsonb),
    'scs_attendance', coalesce((select jsonb_agg(to_jsonb(t) order by id) from public.scs_attendance t), '[]'::jsonb),
    'scs_settings', coalesce((select jsonb_agg(to_jsonb(t) order by key) from public.scs_settings t), '[]'::jsonb)
  );
$$;

create or replace function public.scs_restore_snapshot(backup jsonb)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  t jsonb := backup->'tables';
  lifetime boolean := backup->>'scope' = 'lifetime';
  k text;
  maxid bigint;
begin
  if backup->>'type' is distinct from 'scs-live-backup' or backup->>'version' is distinct from '2' or coalesce(backup->>'scope','') not in ('lifetime','year','month') then
    raise exception 'Invalid SCS backup format';
  end if;
  foreach k in array array['scs_manual_data','scs_manual_history','scs_settings','scs_orders','scs_attendance'] loop
    if jsonb_typeof(t->k) is distinct from 'array' then raise exception 'Missing table array: %', k; end if;
  end loop;
  -- Block writes to these tables for the duration of this single restore transaction.
  lock table public.scs_manual_data, public.scs_manual_history, public.scs_settings, public.scs_orders, public.scs_attendance in share row exclusive mode;
  if lifetime then
    delete from public.scs_manual_data;
    delete from public.scs_manual_history;
    delete from public.scs_orders;
    delete from public.scs_attendance;
    delete from public.scs_settings;
  else
    -- Scoped files merge by primary key: entries not in file are left untouched.
    delete from public.scs_manual_data where month_key in (select x->>'month_key' from jsonb_array_elements(t->'scs_manual_data') x);
    delete from public.scs_manual_history where id in (select (x->>'id')::bigint from jsonb_array_elements(t->'scs_manual_history') x);
    delete from public.scs_orders where id in (select (x->>'id')::bigint from jsonb_array_elements(t->'scs_orders') x);
    delete from public.scs_attendance where id in (select (x->>'id')::bigint from jsonb_array_elements(t->'scs_attendance') x);
    delete from public.scs_settings where key in (select x->>'key' from jsonb_array_elements(t->'scs_settings') x);
  end if;
  insert into public.scs_manual_data select * from jsonb_populate_recordset(null::public.scs_manual_data,t->'scs_manual_data');
  insert into public.scs_manual_history overriding system value select * from jsonb_populate_recordset(null::public.scs_manual_history,t->'scs_manual_history');
  insert into public.scs_orders overriding system value select * from jsonb_populate_recordset(null::public.scs_orders,t->'scs_orders');
  insert into public.scs_attendance overriding system value select * from jsonb_populate_recordset(null::public.scs_attendance,t->'scs_attendance');
  insert into public.scs_settings select * from jsonb_populate_recordset(null::public.scs_settings,t->'scs_settings');
  -- Identity sequence values must be ahead of restored identifiers.
  select max(id) into maxid from public.scs_orders;
  perform setval(pg_get_serial_sequence('public.scs_orders','id'),greatest(coalesce(maxid,0),1),maxid is not null);
  select max(id) into maxid from public.scs_attendance;
  perform setval(pg_get_serial_sequence('public.scs_attendance','id'),greatest(coalesce(maxid,0),1),maxid is not null);
  select max(id) into maxid from public.scs_manual_history;
  perform setval(pg_get_serial_sequence('public.scs_manual_history','id'),greatest(coalesce(maxid,0),1),maxid is not null);
  return jsonb_build_object('ok',true,'scope',backup->>'scope');
end $$;

grant execute on function public.scs_export_snapshot() to anon, authenticated;
grant execute on function public.scs_restore_snapshot(jsonb) to anon, authenticated;
-- setval() needs UPDATE on each identity sequence. Existing data policies are
-- already open to anon; this does not provide authentication or access control.
do $$
declare name text; seq text;
begin
 foreach name in array array['scs_orders','scs_attendance','scs_manual_history'] loop
   seq := pg_get_serial_sequence('public.' || name, 'id');
   if seq is null then raise exception 'Missing identity sequence for %',name; end if;
   execute format('grant usage, select, update on sequence %s to anon, authenticated',seq);
 end loop;
end $$;

-- Reset only if the live tables still match the verified lifetime backup.
-- Storage objects are deliberately retained; table reset is atomic.
create or replace function public.scs_reset_after_verified_backup(expected jsonb)
returns jsonb language plpgsql security invoker set search_path = public as $$
begin
 if expected->>'type' is distinct from 'scs-live-backup' or expected->>'version' is distinct from '2' or expected->>'scope' is distinct from 'lifetime' or jsonb_typeof(expected->'tables') is distinct from 'object' then
   raise exception 'A valid lifetime SCS backup is required';
 end if;
 lock table public.scs_manual_data, public.scs_manual_history, public.scs_settings, public.scs_orders, public.scs_attendance in share row exclusive mode;
 if public.scs_export_snapshot() is distinct from expected->'tables' then
   raise exception 'Database changed after backup; create and verify a fresh lifetime backup';
 end if;
 delete from public.scs_manual_data;
 delete from public.scs_manual_history;
 delete from public.scs_orders;
 delete from public.scs_attendance;
 delete from public.scs_settings;
 return jsonb_build_object('ok',true,'storage_retained',true);
end $$;
grant execute on function public.scs_reset_after_verified_backup(jsonb) to anon, authenticated;

-- Import historical scs-backup v2 (months/settings) without deleting unrelated
-- months or orders. A collision with a different existing order aborts atomically.
create or replace function public.scs_import_legacy_backup(payload jsonb)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare m record; v_max bigint;
begin
 if payload->>'format' is distinct from 'scs-legacy-import' or payload->>'version' is distinct from '1'
   or jsonb_typeof(payload->'months') is distinct from 'object'
   or jsonb_typeof(payload->'settings') is distinct from 'object'
   or jsonb_typeof(payload->'orders') is distinct from 'array'
   or jsonb_typeof(payload->'attendance') is distinct from 'array' then
    raise exception 'Invalid legacy import';
 end if;
 lock table public.scs_manual_data, public.scs_manual_history, public.scs_settings, public.scs_orders, public.scs_attendance in share row exclusive mode;
 if exists (select 1 from jsonb_object_keys(payload->'months') k where k !~ '^\d{4}-(0[1-9]|1[0-2])$') then raise exception 'Invalid month key'; end if;
 if exists (
  select 1 from jsonb_populate_recordset(null::public.scs_orders,payload->'orders') incoming
  join public.scs_orders existing on existing.id=incoming.id
  where lower(trim(coalesce(existing.order_no,'')))<>lower(trim(coalesce(incoming.order_no,'')))
     or lower(trim(coalesce(existing.product_name,'')))<>lower(trim(coalesce(incoming.product_name,'')))
 ) then raise exception 'Order ID collision with different existing data; import aborted without changes'; end if;
 for m in select key,value from jsonb_each(payload->'months') loop
   insert into public.scs_manual_data(month_key,data) values(m.key,m.value)
   on conflict (month_key) do update set data=excluded.data;
 end loop;
 insert into public.scs_orders(id,order_timestamp,order_no,delivery_date_time,client_or_project_name,mobile_number,address,product_name,quantity,unit,pack_size,unit_price,discount_unit_price,total_price,special_price,transport_fee,scs_transport_cost,order_by,engineer_commission_per_unit,contractor_commission_per_unit,commission_holder_name,total_commission,sms_status,pdf_status)
 overriding system value
 select id,order_timestamp,order_no,delivery_date_time,client_or_project_name,mobile_number,address,product_name,quantity,unit,pack_size,unit_price,discount_unit_price,total_price,special_price,transport_fee,scs_transport_cost,order_by,engineer_commission_per_unit,contractor_commission_per_unit,commission_holder_name,total_commission,sms_status,pdf_status
 from jsonb_populate_recordset(null::public.scs_orders,payload->'orders')
 on conflict (id) do update set order_timestamp=excluded.order_timestamp,order_no=excluded.order_no,delivery_date_time=excluded.delivery_date_time,client_or_project_name=excluded.client_or_project_name,mobile_number=excluded.mobile_number,address=excluded.address,product_name=excluded.product_name,quantity=excluded.quantity,unit=excluded.unit,pack_size=excluded.pack_size,unit_price=excluded.unit_price,discount_unit_price=excluded.discount_unit_price,total_price=excluded.total_price,special_price=excluded.special_price,transport_fee=excluded.transport_fee,scs_transport_cost=excluded.scs_transport_cost,order_by=excluded.order_by,engineer_commission_per_unit=excluded.engineer_commission_per_unit,contractor_commission_per_unit=excluded.contractor_commission_per_unit,commission_holder_name=excluded.commission_holder_name,total_commission=excluded.total_commission,sms_status=excluded.sms_status,pdf_status=excluded.pdf_status;
 delete from public.scs_attendance where month_key in (select key from jsonb_each(payload->'months') where jsonb_typeof(value->'attendances')='array');
 insert into public.scs_attendance(month_key,sl_no,emp_id,name,designation,total_present,total_absent,late_days,attendance_rate,last_leave_date)
 select month_key,sl_no,emp_id,name,designation,total_present,total_absent,late_days,attendance_rate,last_leave_date from jsonb_populate_recordset(null::public.scs_attendance,payload->'attendance');
 insert into public.scs_settings(key,value) select key,value from jsonb_each_text(payload->'settings')
 on conflict (key) do update set value=excluded.value;
 select max(id) into v_max from public.scs_orders;
 perform setval(pg_get_serial_sequence('public.scs_orders','id'),greatest(coalesce(v_max,0),1),v_max is not null);
 return jsonb_build_object('ok',true,'months',(select count(*) from jsonb_object_keys(payload->'months')),'orders',jsonb_array_length(payload->'orders'),'attendance',jsonb_array_length(payload->'attendance'));
end $$;
grant execute on function public.scs_import_legacy_backup(jsonb) to anon, authenticated;
