-- =====================================================================
--  SCS Monthly Report  -  Supabase database schema
--  Swarup Construction Solution
-- =====================================================================
--  কীভাবে ব্যবহার করবেন (একবারই করতে হবে):
--    Supabase Dashboard  ->  SQL Editor  ->  New query
--    এই পুরো ফাইলটি পেস্ট করে "Run" চাপুন।
--  বারবার Run করলেও কোনো সমস্যা নেই (idempotent) - ডাটা মুছে যাবে না।
--
--  এটি যা তৈরি করে:
--    scs_manual_data     : মাসভিত্তিক ম্যানুয়াল ইনপুট (কালেকশন, বাকি, বেতন, লোন ইত্যাদি)
--    scs_manual_history  : স্বয়ংক্রিয় ব্যাকআপ / রিসেটের আগের কপি
--    scs_settings        : সেটিংস (সিগনেচার, অ্যাডমিন পিন, এডিট পারমিশন ইত্যাদি)
--    scs_orders          : অর্ডার ডাটা (আগের "SCS Order" শিট)
--    scs_attendance      : মাসভিত্তিক অ্যাটেনডেন্স (আগের "Employee Attendance" শিট)
--    Storage bucket      : scs-files (লোগো ও গান)
--    Realtime            : সব টেবিলে চালু (রিফ্রেশ ছাড়াই সব ডিভাইসে আপডেট)
-- =====================================================================

-- ---------- 1) Tables ----------------------------------------------------

create table if not exists public.scs_manual_data (
  month_key  text primary key,                       -- যেমন 2026-05
  data       jsonb       not null default '{}'::jsonb,
  rev        bigint      not null default 1,         -- প্রতিবার সেভে ১ করে বাড়ে
  updated_at timestamptz not null default now()
);

create table if not exists public.scs_manual_history (
  id         bigint generated always as identity primary key,
  saved_at   timestamptz not null default now(),
  note       text,
  month_key  text  not null,
  data       jsonb not null
);
create index if not exists scs_manual_history_month_idx
  on public.scs_manual_history (month_key, saved_at desc);

create table if not exists public.scs_settings (
  key        text primary key,
  value      text        not null default '',
  updated_at timestamptz not null default now()
);

create table if not exists public.scs_orders (
  id                              bigint generated always as identity primary key,
  created_at                      timestamptz not null default now(),
  order_timestamp                 text,
  order_no                        text,
  delivery_date_time              text,
  client_or_project_name          text,
  mobile_number                   text,
  address                         text,
  product_name                    text,
  quantity                        numeric not null default 0,
  unit                            text,
  pack_size                       text,
  unit_price                      numeric not null default 0,
  discount_unit_price             numeric not null default 0,
  total_price                     numeric not null default 0,
  special_price                   numeric not null default 0,
  transport_fee                   numeric not null default 0,
  scs_transport_cost              numeric not null default 0,
  order_by                        text,
  engineer_commission_per_unit    numeric not null default 0,
  contractor_commission_per_unit  numeric not null default 0,
  commission_holder_name          text,
  total_commission                numeric not null default 0,
  sms_status                      text,
  pdf_status                      text
);
create index if not exists scs_orders_order_no_idx on public.scs_orders (order_no);

create table if not exists public.scs_attendance (
  id               bigint generated always as identity primary key,
  created_at       timestamptz not null default now(),
  month_key        text    not null,                 -- যেমন 2026-05
  sl_no            integer not null default 0,
  emp_id           text,
  name             text,
  designation      text,
  total_present    numeric not null default 0,
  total_absent     numeric not null default 0,
  late_days        numeric not null default 0,
  attendance_rate  text,
  last_leave_date  text
);
create index if not exists scs_attendance_month_idx on public.scs_attendance (month_key, sl_no);

-- ---------- 2) Triggers ---------------------------------------------------

-- ম্যানুয়াল ডাটা: সংস্করণ (rev) বাড়ানো + ৩০ মিনিট পর পর স্বয়ংক্রিয় ব্যাকআপ
create or replace function public.scs_manual_data_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' then
    new.rev := coalesce(old.rev, 0) + 1;
    if not exists (
      select 1 from public.scs_manual_history h
      where h.month_key = old.month_key
        and h.saved_at > now() - interval '30 minutes'
    ) then
      insert into public.scs_manual_history (month_key, data, note)
      values (old.month_key, old.data, 'auto backup');
      delete from public.scs_manual_history
      where id in (select id from public.scs_manual_history order by id desc offset 400);
    end if;
  else
    new.rev := 1;
  end if;
  return new;
end;
$$;

drop trigger if exists scs_manual_data_touch_trg on public.scs_manual_data;
create trigger scs_manual_data_touch_trg
  before insert or update on public.scs_manual_data
  for each row execute function public.scs_manual_data_touch();

create or replace function public.scs_settings_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists scs_settings_touch_trg on public.scs_settings;
create trigger scs_settings_touch_trg
  before insert or update on public.scs_settings
  for each row execute function public.scs_settings_touch();

-- ---------- 3) Access (RLS) -----------------------------------------------
-- অ্যাপে আলাদা লগইন নেই (PIN দিয়ে সুরক্ষিত), তাই publishable (anon) key-কে
-- এই টেবিলগুলোতে পড়া/লেখার অনুমতি দেওয়া হয়েছে।

alter table public.scs_manual_data    enable row level security;
alter table public.scs_manual_history enable row level security;
alter table public.scs_settings       enable row level security;
alter table public.scs_orders         enable row level security;
alter table public.scs_attendance     enable row level security;

do $$
declare t text;
begin
  foreach t in array array['scs_manual_data','scs_manual_history','scs_settings','scs_orders','scs_attendance']
  loop
    execute format('drop policy if exists "scs_open_access" on public.%I', t);
    execute format(
      'create policy "scs_open_access" on public.%I for all to anon, authenticated using (true) with check (true)', t);
  end loop;
end $$;

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on
  public.scs_manual_data, public.scs_manual_history, public.scs_settings,
  public.scs_orders, public.scs_attendance
  to anon, authenticated;
grant usage, select on all sequences in schema public to anon, authenticated;

-- ---------- 4) Realtime ---------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['scs_manual_data','scs_settings','scs_orders','scs_attendance']
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ---------- 5) Storage (লোগো ও গান) -----------------------------------------

insert into storage.buckets (id, name, public)
values ('scs-files', 'scs-files', true)
on conflict (id) do update set public = true;

drop policy if exists "scs_files_open_access" on storage.objects;
create policy "scs_files_open_access" on storage.objects
  for all to anon, authenticated
  using (bucket_id = 'scs-files')
  with check (bucket_id = 'scs-files');

-- Done ✅
