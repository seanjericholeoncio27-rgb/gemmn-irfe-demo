-- 09_real_system_parity.sql
-- Brings the DEMO database up to parity with the REAL IRFE database:
--   * the unique indexes and ON DELETE rules the real schema has
--   * all business-logic triggers (stock movement, auto timeline, invoice->project
--     sync, auto-Paid on CR #, quotation approval on PO, loan/advance balances,
--     audit log)
-- Definitions were read from the real database (read-only) and copied verbatim.
-- Safe to re-run.

-- ── 1. Job order number: same format/signature as the real function ──────────────
drop function if exists public.get_next_job_order_number();
create or replace function public.get_next_job_order_number(target_date date default current_date)
returns text language plpgsql security definer as $fn$
declare next_num integer;
begin
  insert into public.job_order_counters (order_date, last_number) values (target_date, 1)
  on conflict (order_date) do update set last_number = job_order_counters.last_number + 1
  returning last_number into next_num;
  return to_char(target_date, 'YYYYMMDD') || lpad(next_num::text, 3, '0');
end; $fn$;

-- ── 2. Unique / lookup indexes the real schema has ───────────────────────────────
create unique index if not exists project_timeline_ref_key_uniq on public.project_timeline (ref_key) where ref_key is not null;
create unique index if not exists project_item_quantities_po_number_item_line_uid_key on public.project_item_quantities (po_number, item_line_uid);
create unique index if not exists quotation_items_qid_lineuid_uniq on public.quotation_items (quotation_id, line_uid);
create unique index if not exists inventory_name_key_uniq on public.inventory ((regexp_replace(lower(name), '[^a-z0-9]', '', 'g'))) where regexp_replace(lower(name), '[^a-z0-9]', '', 'g') <> '';
create unique index if not exists payroll_emp_period_uniq on public.payroll (employee_id, period);
create unique index if not exists attendance_logs_employee_id_date_key on public.attendance_logs (employee_id, date);
create unique index if not exists thirteenth_month_overrides_employee_id_year_key on public.thirteenth_month_overrides (employee_id, year);
create unique index if not exists roles_name_unique on public.roles (name);
create index if not exists idx_audit_changed_at on public.audit_log (changed_at desc);
create index if not exists idx_audit_table_record on public.audit_log (table_name, record_id);
create index if not exists idx_company_contacts_company on public.company_contacts (company_name);
create index if not exists employee_rates_emp_idx on public.employee_rates (employee_id, effective_from);
create index if not exists idx_equip_assign_equipment on public.equipment_assignments (equipment_id);
create index if not exists idx_equip_assign_po on public.equipment_assignments (po_number);
create index if not exists idx_ii_source_line_uid on public.invoice_items (source_line_uid);
create index if not exists idx_invoices_po on public.invoices (po_number);
create index if not exists idx_material_requests_quotation on public.material_requests (quotation_id);
create index if not exists idx_qi_line_uid on public.quotation_items (line_uid);
create index if not exists idx_quotations_po on public.quotations (po_number);
create index if not exists idx_quotations_root on public.quotations (root_quotation_id);

-- ── 3. Foreign-key delete rules (cascade / set null / restrict) as in the real schema ─
do $$
declare r record; cname text;
begin
  for r in select * from (values
    ('attendance_logs','employee_id','employees','id','CASCADE'),
    ('biometric_employee_map','employee_id','employees','id','CASCADE'),
    ('cash_advance_payments','cash_advance_id','cash_advances','id','CASCADE'),
    ('cash_advance_payments','payroll_id','payroll','id','SET NULL'),
    ('cash_advances','employee_id','employees','id','CASCADE'),
    ('employee_loans','employee_id','employees','id','CASCADE'),
    ('employee_rates','employee_id','employees','id','CASCADE'),
    ('equipment_assignments','equipment_id','equipment','id','CASCADE'),
    ('equipment_loan_payments','expense_id','expenses','id','SET NULL'),
    ('equipment_loan_payments','loan_id','equipment_loans','id','CASCADE'),
    ('equipment_loans','equipment_id','equipment','id','CASCADE'),
    ('invoice_items','invoice_id','invoices','id','CASCADE'),
    ('invoices','quotation_id','quotations','id','SET NULL'),
    ('loan_payments','loan_id','employee_loans','id','CASCADE'),
    ('loan_payments','payroll_record_id','payroll','id','SET NULL'),
    ('material_excess_returns','release_id','material_releases','id','RESTRICT'),
    ('material_requests','bom_id','project_bom','id','SET NULL'),
    ('payroll','employee_id','employees','id','CASCADE'),
    ('payroll','payroll_run_id','payroll_runs','id','SET NULL'),
    ('project_bom','po_number','projects','po_number','CASCADE'),
    ('project_timeline','po_number','projects','po_number','CASCADE'),
    ('projects','invoice_id','invoices','id','SET NULL'),
    ('projects','quotation_id','quotations','id','SET NULL'),
    ('quotation_items','quotation_id','quotations','id','CASCADE'),
    ('supplier_materials','supplier_id','suppliers','id','CASCADE'),
    ('supplier_quotes','material_request_id','material_requests','id','CASCADE'),
    ('thirteenth_month_overrides','employee_id','employees','id','CASCADE')
  ) as v(t, c, rt, rc, act)
  loop
    select con.conname into cname
    from pg_constraint con
    join pg_attribute a on a.attrelid = con.conrelid and a.attnum = any(con.conkey)
    where con.contype = 'f' and con.conrelid = ('public.'||r.t)::regclass and a.attname = r.c
    limit 1;
    if cname is not null then
      execute format('alter table public.%I drop constraint %I', r.t, cname);
      execute format('alter table public.%I add constraint %I foreign key (%I) references public.%I (%I) on delete %s',
                     r.t, cname, r.c, r.rt, r.rc, r.act);
    end if;
  end loop;
end $$;

-- ── 4. Trigger functions (verbatim from the real database) ───────────────────────
create or replace function public.tl_log(p_po text, p_type text, p_notes text, p_ref text, p_date date default current_date)
returns void language plpgsql security definer set search_path to 'public' as $fn$
begin
  if p_po is null or btrim(p_po) = '' then return; end if;
  if not exists (select 1 from projects where po_number = p_po) then return; end if;
  insert into project_timeline (po_number, event_type, event_date, notes, source, ref_key)
  values (p_po, p_type, coalesce(p_date, current_date), p_notes, 'auto', p_ref)
  on conflict (ref_key) where ref_key is not null do nothing;
exception when others then
  null;
end $fn$;

create or replace function public.tl_stamp_user() returns trigger language plpgsql security definer set search_path to 'public' as $fn$
begin
  if new.created_by_name is null then
    select full_name into new.created_by_name from profiles where id = auth.uid();
  end if;
  return new;
end $fn$;

create or replace function public.tl_protect_auto() returns trigger language plpgsql as $fn$
begin
  if old.source = 'auto' and pg_trigger_depth() = 1 then
    raise exception 'Automatic timeline entries are permanent and cannot be edited or deleted.';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $fn$;

create or replace function public.tl_on_invoice() returns trigger language plpgsql security definer set search_path to 'public' as $fn$
begin
  if new.po_number is not null and (tg_op = 'INSERT' or old.po_number is distinct from new.po_number) then
    perform tl_log(new.po_number, 'Invoiced', 'Invoice ' || new.id || coalesce(' — ' || new.client, ''), 'inv:' || new.id, coalesce(new.date, current_date));
  end if;
  if new.po_number is not null and new.status = 'Paid' and (tg_op = 'INSERT' or old.status is distinct from 'Paid') then
    perform tl_log(new.po_number, 'Invoice Paid', 'Invoice ' || new.id || ' marked Paid', 'invpaid:' || new.id, current_date);
  end if;
  return new;
end $fn$;

create or replace function public.tl_on_material_request() returns trigger language plpgsql security definer set search_path to 'public' as $fn$
begin
  perform tl_log(new.po_number, 'Material Requested',
    trim(coalesce(new.qty_needed::text,'') || ' ' || coalesce(new.unit,'')) || ' of ' || coalesce(new.material_name,'material') || ' sent to Purchasing',
    'mr:' || new.id::text, coalesce(new.date_requested, current_date));
  return new;
end $fn$;

create or replace function public.tl_on_po_item() returns trigger language plpgsql security definer set search_path to 'public' as $fn$
declare v_po text; sup text;
begin
  select coalesce(mr.po_number, p.po_number), s.name into v_po, sup
  from purchase_orders p
  left join material_requests mr on mr.id = new.material_request_id
  left join suppliers s on s.id = p.supplier_id
  where p.id = new.purchase_order_id;
  perform tl_log(v_po, 'Supplier PO Issued',
    coalesce(new.material_name,'Material') || ' ×' || new.qty::text || ' ' || coalesce(new.unit,'') || ' ordered from ' || coalesce(sup,'supplier') || ' (Supplier PO ' || new.purchase_order_id || ')',
    'poi:' || new.id, current_date);
  return new;
end $fn$;

create or replace function public.tl_on_quote_selected() returns trigger language plpgsql security definer set search_path to 'public' as $fn$
declare mr record; sup text;
begin
  if new.selected is true and (tg_op = 'INSERT' or old.selected is distinct from true) then
    select po_number, material_name into mr from material_requests where id = new.material_request_id;
    select name into sup from suppliers where id = new.supplier_id;
    perform tl_log(mr.po_number, 'Quote Approved',
      coalesce(mr.material_name,'Material') || ' — ' || coalesce(sup,'supplier') || ' @ ₱' || to_char(new.quoted_price, 'FM999,999,990.00'),
      'sq:' || new.id::text, current_date);
  end if;
  return new;
end $fn$;

create or replace function public.tl_on_release() returns trigger language plpgsql security definer set search_path to 'public' as $fn$
begin
  perform tl_log(new.po_number, 'Material Released',
    trim(new.qty::text || ' ' || coalesce(new.unit,'')) || ' of ' || coalesce(new.material_name,'material') ||
      case when new.bom_id is not null then ' fulfilled from existing stock' else ' released to ' || coalesce(new.requestor,'—') end,
    'rel:' || new.id::text, coalesce(new.date, current_date));
  return new;
end $fn$;

create or replace function public.tl_on_replenishment() returns trigger language plpgsql security definer set search_path to 'public' as $fn$
declare v_po text;
begin
  v_po := new.po_number;
  if v_po is null and new.purchase_order_id is not null then
    select coalesce(p.po_number, (select mr.po_number from purchase_order_items poi join material_requests mr on mr.id = poi.material_request_id where poi.purchase_order_id = p.id and mr.po_number is not null limit 1))
      into v_po from purchase_orders p where p.id = new.purchase_order_id;
  end if;
  perform tl_log(v_po, 'Material Received',
    new.qty::text || ' ' || coalesce(new.material_name,'material') || ' received' || coalesce(' (Supplier PO ' || new.purchase_order_id || ')', ''),
    'rep:' || new.id::text, coalesce(new.date, current_date));
  return new;
end $fn$;

create or replace function public.apply_cash_advance_payment() returns trigger language plpgsql security definer as $fn$
begin
  update public.cash_advances set balance = balance - new.amount,
         status = case when balance - new.amount <= 0 then 'Closed' else 'Open' end
  where id = new.cash_advance_id;
  return new;
end; $fn$;
create or replace function public.reverse_cash_advance_payment() returns trigger language plpgsql security definer as $fn$
begin
  update public.cash_advances set balance = balance + old.amount, status = 'Open' where id = old.cash_advance_id;
  return old;
end; $fn$;
create or replace function public.apply_equipment_loan_payment() returns trigger language plpgsql security definer as $fn$
begin
  update public.equipment_loans set balance = balance - new.amount,
         status = case when balance - new.amount <= 0 then 'Fully Paid' else 'Financing' end
  where id = new.loan_id;
  return new;
end; $fn$;
create or replace function public.reverse_equipment_loan_payment() returns trigger language plpgsql security definer as $fn$
begin
  update public.equipment_loans set balance = balance + old.amount, status = 'Financing' where id = old.loan_id;
  return old;
end; $fn$;
create or replace function public.apply_loan_payment() returns trigger language plpgsql security definer as $fn$
begin
  update public.employee_loans set balance = balance - new.amount,
         status = case when balance - new.amount <= 0 then 'Closed' else 'Open' end
  where id = new.loan_id;
  return new;
end; $fn$;
create or replace function public.reverse_loan_payment() returns trigger language plpgsql security definer as $fn$
begin
  update public.employee_loans set balance = balance + old.amount, status = 'Open' where id = old.loan_id;
  return old;
end; $fn$;

create or replace function public.apply_excess_return() returns trigger language plpgsql security definer as $fn$
begin
  update public.inventory set quantity = quantity + new.qty_returned where id = new.material_id;
  return new;
end; $fn$;
create or replace function public.reverse_excess_return() returns trigger language plpgsql security definer as $fn$
begin
  if old.qty_remaining < old.qty_returned then
    raise exception 'Cannot delete this excess return — % of it has already been reused by a later release. Reverse that release first.', (old.qty_returned - old.qty_remaining);
  end if;
  update public.inventory set quantity = quantity - old.qty_returned where id = old.material_id;
  return old;
end; $fn$;
create or replace function public.apply_material_release() returns trigger language plpgsql security definer as $fn$
begin
  if new.source = 'Excess Pool' and new.excess_return_id is not null then
    update public.material_excess_returns set qty_remaining = qty_remaining - new.qty where id = new.excess_return_id;
  else
    update public.inventory set quantity = quantity - new.qty where id = new.material_id;
  end if;
  return new;
end; $fn$;
create or replace function public.reverse_material_release() returns trigger language plpgsql security definer as $fn$
begin
  if old.source = 'Excess Pool' and old.excess_return_id is not null then
    update public.material_excess_returns set qty_remaining = qty_remaining + old.qty where id = old.excess_return_id;
  else
    update public.inventory set quantity = quantity + old.qty where id = old.material_id;
  end if;
  return old;
end; $fn$;
create or replace function public.apply_replenishment() returns trigger language plpgsql security definer as $fn$
begin
  update public.inventory set quantity = quantity + new.qty where id = new.material_id;
  return new;
end; $fn$;
create or replace function public.reverse_replenishment() returns trigger language plpgsql security definer as $fn$
begin
  update public.inventory set quantity = quantity - old.qty where id = old.material_id;
  return old;
end; $fn$;

create or replace function public.auto_paid_on_cr() returns trigger language plpgsql security definer as $fn$
begin
  if new.cr_number is not null and btrim(new.cr_number) <> '' then new.status := 'Paid'; end if;
  return new;
end; $fn$;
create or replace function public.quo_approve_on_po() returns trigger language plpgsql as $fn$
begin
  if new.po_number is not null and btrim(new.po_number) <> '' and new.status in ('Draft','Sent') then new.status := 'Approved'; end if;
  return new;
end $fn$;

create or replace function public.sync_project_from_invoice() returns trigger language plpgsql security definer as $fn$
begin
  update public.projects set value = (
    select sum(ii.qty*ii.price) * (case when bool_or(i.vat_mode = 'included') then 1 else 1 + coalesce(max(i.tax),0.12) end)
    from invoice_items ii join invoices i on i.id = ii.invoice_id
    where ii.invoice_id = new.id and ii.kind = 'item')
  where invoice_id = new.id;
  return new;
end; $fn$;
create or replace function public.sync_project_from_invoice_items() returns trigger language plpgsql security definer as $fn$
declare target_invoice_id text;
begin
  target_invoice_id := coalesce(new.invoice_id, old.invoice_id);
  update public.projects set value = (
    select sum(ii.qty*ii.price) * (case when bool_or(i.vat_mode = 'included') then 1 else 1 + coalesce(max(i.tax),0.12) end)
    from invoice_items ii join invoices i on i.id = ii.invoice_id
    where ii.invoice_id = target_invoice_id and ii.kind = 'item')
  where invoice_id = target_invoice_id;
  return coalesce(new, old);
end; $fn$;
create or replace function public.sync_project_value_from_own_invoice_id() returns trigger language plpgsql security definer as $fn$
begin
  if new.invoice_id is not null then
    new.value := (
      select sum(ii.qty*ii.price) * (case when bool_or(i.vat_mode = 'included') then 1 else 1 + coalesce(max(i.tax),0.12) end)
      from invoice_items ii join invoices i on i.id = ii.invoice_id
      where ii.invoice_id = new.invoice_id and ii.kind = 'item');
  end if;
  return new;
end; $fn$;

create or replace function public.log_audit_event() returns trigger language plpgsql security definer as $fn$
declare actor_id uuid; actor_name text;
begin
  actor_id := auth.uid();
  select full_name into actor_name from public.profiles where id = actor_id;
  if tg_op = 'DELETE' then
    insert into public.audit_log(table_name, record_id, action, changed_by, changed_by_name, old_data)
    values (tg_table_name, old.id::text, tg_op, actor_id, coalesce(actor_name,'System'), to_jsonb(old));
    return old;
  elsif tg_op = 'UPDATE' then
    if to_jsonb(old) = to_jsonb(new) then return new; end if;
    insert into public.audit_log(table_name, record_id, action, changed_by, changed_by_name, old_data, new_data)
    values (tg_table_name, new.id::text, tg_op, actor_id, coalesce(actor_name,'System'), to_jsonb(old), to_jsonb(new));
    return new;
  elsif tg_op = 'INSERT' then
    insert into public.audit_log(table_name, record_id, action, changed_by, changed_by_name, new_data)
    values (tg_table_name, new.id::text, tg_op, actor_id, coalesce(actor_name,'System'), to_jsonb(new));
    return new;
  end if;
  return null;
end; $fn$;

-- ── 5. Triggers ──────────────────────────────────────────────────────────────────
do $$
declare d text;
begin
  foreach d in array array[
    'trg_apply_ca_payment|cash_advance_payments|AFTER INSERT|apply_cash_advance_payment',
    'trg_reverse_ca_payment|cash_advance_payments|AFTER DELETE|reverse_cash_advance_payment',
    'trg_apply_equipment_loan_payment|equipment_loan_payments|AFTER INSERT|apply_equipment_loan_payment',
    'trg_reverse_equipment_loan_payment|equipment_loan_payments|AFTER DELETE|reverse_equipment_loan_payment',
    'trg_apply_loan_payment|loan_payments|AFTER INSERT|apply_loan_payment',
    'trg_reverse_loan_payment|loan_payments|AFTER DELETE|reverse_loan_payment',
    'trg_apply_excess_return|material_excess_returns|AFTER INSERT|apply_excess_return',
    'trg_reverse_excess_return|material_excess_returns|BEFORE DELETE|reverse_excess_return',
    'trg_apply_material_release|material_releases|AFTER INSERT|apply_material_release',
    'trg_reverse_material_release|material_releases|AFTER DELETE|reverse_material_release',
    'trg_tl_release|material_releases|AFTER INSERT|tl_on_release',
    'trg_apply_replenishment|material_replenishments|AFTER INSERT|apply_replenishment',
    'trg_reverse_replenishment|material_replenishments|AFTER DELETE|reverse_replenishment',
    'trg_tl_replenishment|material_replenishments|AFTER INSERT|tl_on_replenishment',
    'trg_tl_material_request|material_requests|AFTER INSERT|tl_on_material_request',
    'trg_tl_po_item|purchase_order_items|AFTER INSERT|tl_on_po_item',
    'trg_tl_protect_auto|project_timeline|BEFORE DELETE OR UPDATE|tl_protect_auto',
    'trg_tl_stamp_user|project_timeline|BEFORE INSERT|tl_stamp_user',
    'trg_sync_project_from_invoice_items|invoice_items|AFTER INSERT OR DELETE OR UPDATE|sync_project_from_invoice_items',
    'trg_sync_project_from_invoice|invoices|AFTER INSERT OR UPDATE|sync_project_from_invoice',
    'trg_sync_project_value_from_own_invoice_id|projects|BEFORE INSERT OR UPDATE|sync_project_value_from_own_invoice_id',
    'trg_tl_invoice|invoices|AFTER INSERT OR UPDATE OF po_number, status|tl_on_invoice',
    'trg_auto_paid_on_cr|invoices|BEFORE INSERT OR UPDATE OF cr_number|auto_paid_on_cr',
    'trg_quo_approve_on_po|quotations|BEFORE INSERT OR UPDATE OF po_number, status|quo_approve_on_po',
    'trg_tl_quote_selected|supplier_quotes|AFTER INSERT OR UPDATE OF selected|tl_on_quote_selected',
    'trg_audit_cash_advances|cash_advances|AFTER INSERT OR DELETE OR UPDATE|log_audit_event',
    'trg_audit_employee_loans|employee_loans|AFTER INSERT OR DELETE OR UPDATE|log_audit_event',
    'trg_audit_expenses|expenses|AFTER INSERT OR DELETE OR UPDATE|log_audit_event',
    'trg_audit_inventory|inventory|AFTER INSERT OR DELETE OR UPDATE|log_audit_event',
    'trg_audit_invoices|invoices|AFTER INSERT OR DELETE OR UPDATE|log_audit_event',
    'trg_audit_payroll|payroll|AFTER INSERT OR DELETE OR UPDATE|log_audit_event',
    'trg_audit_projects|projects|AFTER INSERT OR DELETE OR UPDATE|log_audit_event',
    'trg_audit_purchase_orders|purchase_orders|AFTER INSERT OR DELETE OR UPDATE|log_audit_event',
    'trg_audit_quotations|quotations|AFTER INSERT OR DELETE OR UPDATE|log_audit_event'
  ] loop
    execute format('drop trigger if exists %I on public.%I', split_part(d,'|',1), split_part(d,'|',2));
    execute format('create trigger %I %s on public.%I for each row execute function public.%I()',
                   split_part(d,'|',1), split_part(d,'|',3), split_part(d,'|',2), split_part(d,'|',4));
  end loop;
end $$;
