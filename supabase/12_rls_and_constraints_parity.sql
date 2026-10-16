-- 12_rls_and_constraints_parity.sql
-- Brings the demo's access rules and integrity constraints in line with the real system:
--   * role-based Row Level Security (viewer = read-only at the database level, not just in the UI)
--   * the same roles the real app defines
--   * the unique keys / cascade rules the real database enforces
-- Intentional demo-only differences that remain: sign-up trigger (handle_new_user) is NOT installed
-- so strangers cannot self-register through the public API; role "admin" is the demo's full-access role.
-- Safe to re-run.

-- 1. Roles used by the real app (module access per role) ------------------------------------------
insert into roles (name, label, is_system, full_access, can_edit, can_manage_users, modules, edit_modules) values
 ('manager','Manager',true,true,true,true,'{dashboard,projects,inventory,resources,reports,access}','{dashboard,projects,inventory,resources,reports,access}'),
 ('sales','Sales',false,false,true,false,'{projects,quotations,invoices}','{projects,quotations,invoices}'),
 ('design','Design',false,false,true,false,'{quotations}','{quotations}'),
 ('hr','HR',false,false,true,false,'{payroll}','{payroll}'),
 ('warehouse','Warehouse',false,false,true,false,'{inventory,resources}','{inventory,resources}'),
 ('purchasing_officer','Purchasing Officer',false,false,true,false,'{purchasing,projects,inventory,resources}','{purchasing,inventory,resources}')
on conflict (name) do nothing;

-- 2. Constraints the real database has ---------------------------------------------------------------
do $$
declare r record;
begin
  -- unique keys: promote an existing same-named unique index to a constraint, otherwise create it
  for r in select * from (values
    ('attendance_logs','attendance_logs_employee_id_date_key','employee_id, date'),
    ('project_item_quantities','project_item_quantities_po_number_item_line_uid_key','po_number, item_line_uid'),
    ('quotation_items','quotation_items_qid_lineuid_uniq','quotation_id, line_uid'),
    ('roles','roles_name_unique','name'),
    ('thirteenth_month_overrides','thirteenth_month_overrides_employee_id_year_key','employee_id, year')
  ) v(tbl, cname, cols) loop
    if not exists (select 1 from pg_constraint where conname = r.cname) then
      if exists (select 1 from pg_class where relname = r.cname and relkind = 'i') then
        execute format('alter table public.%I add constraint %I unique using index %I', r.tbl, r.cname, r.cname);
      else
        execute format('alter table public.%I add constraint %I unique (%s)', r.tbl, r.cname, r.cols);
      end if;
    end if;
  end loop;
  if exists (select 1 from pg_constraint where conname='profiles_id_fkey' and confdeltype <> 'c') then
    alter table profiles drop constraint profiles_id_fkey;
    alter table profiles add constraint profiles_id_fkey foreign key (id) references auth.users(id) on delete cascade;
  end if;
end $$;

-- 3. Edit permission check (same as real) -------------------------------------------------------------
create or replace function public.auth_can_edit() returns boolean language sql stable security definer as $fn$
  select coalesce(
    (select r.can_edit or r.full_access
     from public.profiles p join public.roles r on r.name = p.role
     where p.id = auth.uid()),
    false
  );
$fn$;

-- 4. Row Level Security: same policies, same names as the real system -----------------------------------
do $$
declare r record; t text; pol text;
  sel constant text := $q$(auth.role() = 'authenticated'::text)$q$;
begin
  -- clear whatever policies exist on public tables
  for r in select schemaname, tablename, policyname from pg_policies where schemaname='public' loop
    execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
  for t in select tablename from pg_tables where schemaname='public' loop
    execute format('alter table public.%I enable row level security', t);
  end loop;

  -- (table, select-policy name, write-policy name): authenticated read, auth_can_edit() write
  for r in select * from (values
    ('app_settings','settings_select','settings_write'),('attachments','att_select','att_write'),
    ('attendance_logs','attendance_logs_select','attendance_logs_write'),('biometric_employee_map','biometric_employee_map_select','biometric_employee_map_write'),
    ('client_registry','client_registry_select','client_registry_write'),('company_contacts','cc_select','cc_write'),
    ('company_deductions','company_deductions_select','company_deductions_write'),('contribution_settings','contribution_settings_select','contribution_settings_write'),
    ('employee_loans','employee_loans_select','employee_loans_write'),('equipment_assignments','ea_select','ea_write'),
    ('equipment_loan_payments','equipment_loan_payments_select','equipment_loan_payments_write'),('equipment_loans','equipment_loans_select','equipment_loans_write'),
    ('expense_templates','et_select','et_write'),('holidays','holidays_select','holidays_write'),('job_order_counters','joc_select','joc_write'),
    ('labor_types','labor_types_select','labor_types_write'),('loan_payments','loan_payments_select','loan_payments_write'),
    ('material_excess_returns','mer_select','mer_write'),('material_releases','mr_select','mr_write'),('material_requests','mr_select','mr_write'),
    ('material_replenishments','mrep_select','mrep_write'),('payroll_runs','payroll_runs_select','payroll_runs_write'),
    ('project_bom','project_bom_select','project_bom_write'),('project_equipment_usage','peu_select','peu_write'),
    ('project_item_quantities','piq_select','piq_write'),('project_timeline','project_timeline_select','project_timeline_write'),
    ('purchase_order_invoices','poi_select','poi_write'),('purchase_orders','po_select','po_write'),
    ('signatories','signatories_select','signatories_write'),('sss_brackets','sss_brackets_select','sss_brackets_write'),
    ('supplier_materials','supmat_select','supmat_write'),('supplier_quotes','sq_select','sq_write'),('suppliers','sup_select','sup_write'),
    ('thirteenth_month_overrides','thirteenth_month_select','thirteenth_month_write')
  ) v(tbl, s, w) loop
    execute format('create policy %I on public.%I for select using %s', r.s, r.tbl, sel);
    execute format('create policy %I on public.%I for all using (auth_can_edit()) with check (auth_can_edit())', r.w, r.tbl);
  end loop;

  -- tables with separate select / insert / update / delete policies
  foreach t in array array['cash_advance_payments','cash_advances','employees','equipment','expenses','inventory','invoice_items','invoices','payroll','projects','quotation_items','quotations','quotation_templates'] loop
    execute format('create policy %I on public.%I for select using %s', t||'_select', t, sel);
    execute format('create policy %I on public.%I for insert with check (auth_can_edit())', t||'_insert', t);
    if t <> 'quotation_templates' then   -- the real system has no UPDATE policy on quotation templates
      execute format('create policy %I on public.%I for update using (auth_can_edit())', t||'_update', t);
    end if;
    execute format('create policy %I on public.%I for delete using (auth_can_edit())', t||'_delete', t);
  end loop;

  -- accounting tables: any signed-in user (as in the real system)
  foreach t in array array['bank_accounts','bank_statements','bank_transactions','outstanding_checks','petty_cash_fund','petty_cash_periods','petty_cash_voucher_lines','petty_cash_vouchers','purchase_order_items'] loop
    execute format('create policy authenticated_full_access on public.%I for all to authenticated using (true) with check (true)', t);
  end loop;
  create policy "employee_rates auth all" on public.employee_rates for all to authenticated using (true) with check (true);

  create policy audit_select_privileged on public.audit_log for select using (exists (select 1 from profiles p join roles r on r.name = p.role where p.id = auth.uid() and (r.full_access or r.can_manage_users)));
  create policy ledger_chain_read on public.ledger_chain for select to authenticated using (true);
  create policy "Users can read own profile" on public.profiles for select using (auth.uid() = id);
  create policy "Users can update own profile" on public.profiles for update using (auth.uid() = id);
  create policy profiles_select_authenticated on public.profiles for select using (auth.role() = 'authenticated'::text);
  create policy profiles_update_authenticated on public.profiles for update using (auth.role() = 'authenticated'::text);
  create policy roles_select_authenticated on public.roles for select using (auth.role() = 'authenticated'::text);
end $$;

-- 5. Attachments bucket: same access rule as the real system (signed-in users only) --------------------------
drop policy if exists demo_attachments_all on storage.objects;
drop policy if exists attachments_authenticated_all on storage.objects;
create policy attachments_authenticated_all on storage.objects for all
  using (bucket_id = 'attachments' and auth.role() = 'authenticated')
  with check (bucket_id = 'attachments' and auth.role() = 'authenticated');
