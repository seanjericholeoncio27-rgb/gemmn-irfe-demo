-- 13_global_search.sql
-- Global search runs in the database so it can only ever return records from modules the caller's role may open.
-- Run after 12. Safe to re-run.

-- Global search, enforced in the database: every hit is filtered by the caller's role modules.
-- Returns up to per_type hits for each kind of record the caller's role may see.
create or replace function public.global_search(term text, per_type int default 5)
returns table(kind text, module text, rec_id text, label text, sub text, path text, term_key text)
language plpgsql stable security definer set search_path = public as $fn$
declare
  pat text;
  r_full boolean; r_mods text[];
  begin
  if term is null or length(trim(term)) < 2 then return; end if;
  select coalesce(ro.full_access,false), coalesce(ro.modules,'{}')
    into r_full, r_mods
    from profiles p join roles ro on ro.name = p.role
   where p.id = auth.uid();
  if not found then return; end if;
  pat := '%' || replace(replace(replace(trim(term), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  per_type := least(greatest(coalesce(per_type,5),1),25);
  if (r_full or 'quotations' = any(r_mods)) then
    return query select * from (select 'Quotation'::text, 'quotations'::text, x.id::text, (x.id)::text, nullif((concat_ws(' · ', coalesce(x.company_name,x.client), x.status, 'PO '||x.po_number))::text,''), '/dashboard/quotations'::text, (x.id)::text
      from quotations x
      where concat_ws(' ', x.id,x.client,x.company_name,x.attention,x.po_number,x.job_order_number,x.prepared_by,x.notes,x.status,x.root_quotation_id) ilike pat
      order by (lower(x.id::text) = lower(trim(term))) desc, 4 limit per_type) s0;
  end if;
  if (r_full or 'quotations' = any(r_mods)) then
    return query select * from (select 'Quotation Item'::text, 'quotations'::text, q.id||'/'||x.id::text, (x.description)::text, nullif((concat_ws(' · ', 'in '||q.id, coalesce(q.company_name,q.client), x.kind))::text,''), '/dashboard/quotations'::text, (q.id)::text
      from quotation_items x join quotations q on q.id=x.quotation_id
      where concat_ws(' ', x.description,x.dimension,x.details) ilike pat
      order by (lower(q.id||'/'||x.id::text) = lower(trim(term))) desc, 4 limit per_type) s1;
  end if;
  if (r_full or 'quotations' = any(r_mods)) then
    return query select * from (select 'Quote Template'::text, 'quotations'::text, x.id::text, (x.label)::text, nullif((x.description)::text,''), '/dashboard/quotations'::text, (x.label)::text
      from quotation_templates x
      where concat_ws(' ', x.id,x.label,x.description) ilike pat
      order by (lower(x.id::text) = lower(trim(term))) desc, 4 limit per_type) s2;
  end if;
  if (r_full or 'quotations' = any(r_mods)) then
    return query select * from (select 'Client'::text, 'quotations'::text, x.id::text::text, (x.company_name)::text, nullif((x.address)::text,''), '/dashboard/quotations'::text, (x.company_name)::text
      from client_registry x
      where concat_ws(' ', x.company_name,x.address) ilike pat
      order by (lower(x.id::text::text) = lower(trim(term))) desc, 4 limit per_type) s3;
  end if;
  if (r_full or 'quotations' = any(r_mods)) then
    return query select * from (select 'Client Contact'::text, 'quotations'::text, x.id::text::text, (x.contact_name)::text, nullif((concat_ws(' · ', x.position, x.company_name))::text,''), '/dashboard/quotations'::text, (x.contact_name)::text
      from company_contacts x
      where concat_ws(' ', x.contact_name,x.position,x.company_name) ilike pat
      order by (lower(x.id::text::text) = lower(trim(term))) desc, 4 limit per_type) s4;
  end if;
  if (r_full or 'invoices' = any(r_mods)) then
    return query select * from (select 'Invoice'::text, 'invoices'::text, x.id::text, (x.id)::text, nullif((concat_ws(' · ', coalesce(x.company_name,x.client), x.status, 'PO '||x.po_number, 'DR '||x.dr_number, 'CR '||nullif(x.cr_number,'')))::text,''), '/dashboard/invoices'::text, (x.id)::text
      from invoices x
      where concat_ws(' ', x.id,x.client,x.company_name,x.attention,x.po_number,x.dr_number,x.cr_number,x.notes,x.status,x.quotation_id) ilike pat
      order by (lower(x.id::text) = lower(trim(term))) desc, 4 limit per_type) s5;
  end if;
  if (r_full or 'invoices' = any(r_mods)) then
    return query select * from (select 'Invoice Item'::text, 'invoices'::text, i.id||'/'||x.id::text, (x.description)::text, nullif((concat_ws(' · ', 'in '||i.id, coalesce(i.company_name,i.client)))::text,''), '/dashboard/invoices'::text, (i.id)::text
      from invoice_items x join invoices i on i.id=x.invoice_id
      where concat_ws(' ', x.description,x.dimension,x.details) ilike pat
      order by (lower(i.id||'/'||x.id::text) = lower(trim(term))) desc, 4 limit per_type) s6;
  end if;
  if (r_full or 'projects' = any(r_mods)) then
    return query select * from (select 'Project'::text, 'projects'::text, x.id::text, (coalesce(x.name,x.id))::text, nullif((concat_ws(' · ', 'PO '||x.po_number, x.client, x.status, 'DR '||x.dr_number, 'CR '||nullif(x.cr_number,'')))::text,''), '/dashboard/projects'::text, (x.id)::text
      from projects x
      where concat_ws(' ', x.id,x.name,x.client,x.po_number,x.manager,x.notes,x.status,x.dr_number,x.cr_number,x.payment_status,x.type) ilike pat
      order by (lower(x.id::text) = lower(trim(term))) desc, 4 limit per_type) s7;
  end if;
  if (r_full or 'projects' = any(r_mods)) then
    return query select * from (select 'Timeline Event'::text, 'projects'::text, x.id::text::text, (concat_ws(' — ', x.event_type, x.notes))::text, nullif((concat_ws(' · ', 'PO '||x.po_number, x.event_date::text))::text,''), '/dashboard/projects'::text, (coalesce(x.notes,x.event_type))::text
      from project_timeline x
      where concat_ws(' ', x.po_number,x.event_type,x.notes,x.created_by_name) ilike pat
      order by (lower(x.id::text::text) = lower(trim(term))) desc, 4 limit per_type) s8;
  end if;
  if (r_full or 'projects' = any(r_mods)) then
    return query select * from (select 'BOM Line'::text, 'projects'::text, x.id::text::text, (x.description)::text, nullif((concat_ws(' · ', 'PO '||x.po_number, x.status))::text,''), '/dashboard/projects'::text, (x.description)::text
      from project_bom x
      where concat_ws(' ', x.po_number,x.description,x.dimension,x.status) ilike pat
      order by (lower(x.id::text::text) = lower(trim(term))) desc, 4 limit per_type) s9;
  end if;
  if (r_full or 'payroll' = any(r_mods)) then
    return query select * from (select 'Employee'::text, 'payroll'::text, x.id::text, (x.name)::text, nullif((concat_ws(' · ', x.id, x.role, x.department))::text,''), '/dashboard/payroll'::text, (x.name)::text
      from employees x
      where concat_ws(' ', x.id,x.name,x.role,x.department) ilike pat
      order by (lower(x.id::text) = lower(trim(term))) desc, 4 limit per_type) s10;
  end if;
  if (r_full or 'payroll' = any(r_mods)) then
    return query select * from (select 'Payroll Run'::text, 'payroll'::text, x.id::text::text, ('Payroll '||x.period_start||' – '||x.period_end)::text, nullif((x.status)::text,''), '/dashboard/payroll'::text, (x.period_start::text)::text
      from payroll_runs x
      where concat_ws(' ', x.period_start::text,x.period_end::text,x.status) ilike pat
      order by (lower(x.id::text::text) = lower(trim(term))) desc, 4 limit per_type) s11;
  end if;
  if (r_full or 'payroll' = any(r_mods)) then
    return query select * from (select 'Cash Advance'::text, 'payroll'::text, x.id::text, (x.id)::text, nullif((concat_ws(' · ', e.name, x.status))::text,''), '/dashboard/payroll'::text, (x.id)::text
      from cash_advances x left join employees e on e.id=x.employee_id
      where concat_ws(' ', x.id,e.name,x.notes,x.status) ilike pat
      order by (lower(x.id::text) = lower(trim(term))) desc, 4 limit per_type) s12;
  end if;
  if (r_full or 'payroll' = any(r_mods)) then
    return query select * from (select 'Employee Loan'::text, 'payroll'::text, x.id::text, (x.id)::text, nullif((concat_ws(' · ', e.name, x.loan_type, x.status))::text,''), '/dashboard/payroll'::text, (x.id)::text
      from employee_loans x left join employees e on e.id=x.employee_id
      where concat_ws(' ', x.id,e.name,x.loan_type,x.notes,x.status) ilike pat
      order by (lower(x.id::text) = lower(trim(term))) desc, 4 limit per_type) s13;
  end if;
  if (r_full or 'expenses' = any(r_mods)) then
    return query select * from (select 'Expense'::text, 'expenses'::text, x.id::text, (x.id)::text, nullif((concat_ws(' · ', x.description, x.category, x.status))::text,''), '/dashboard/expenses?tab=expenses'::text, (x.id)::text
      from expenses x
      where concat_ws(' ', x.id,x.description,x.category,x.receipt,x.po_number,x.source_id,x.status,x.payment_method) ilike pat
      order by (lower(x.id::text) = lower(trim(term))) desc, 4 limit per_type) s14;
  end if;
  if (r_full or 'expenses' = any(r_mods)) then
    return query select * from (select 'Expense Template'::text, 'expenses'::text, x.id::text::text, (x.name)::text, nullif((concat_ws(' · ', x.category, x.description))::text,''), '/dashboard/expenses?tab=expenses'::text, (x.name)::text
      from expense_templates x
      where concat_ws(' ', x.name,x.category,x.description) ilike pat
      order by (lower(x.id::text::text) = lower(trim(term))) desc, 4 limit per_type) s15;
  end if;
  if (r_full or 'expenses-bank' = any(r_mods)) then
    return query select * from (select 'Bank Transaction'::text, 'expenses-bank'::text, x.id::text, (x.particulars)::text, nullif((concat_ws(' · ', x.id, x.direction, x.category, 'CHK '||x.check_number))::text,''), '/dashboard/expenses?tab=bank'::text, (x.id)::text
      from bank_transactions x
      where concat_ws(' ', x.id,x.particulars,x.check_number,x.source_id,x.po_number,x.invoice_id,x.expense_id,x.category,x.notes) ilike pat
      order by (lower(x.id::text) = lower(trim(term))) desc, 4 limit per_type) s16;
  end if;
  if (r_full or 'expenses-bank' = any(r_mods)) then
    return query select * from (select 'Bank Statement'::text, 'expenses-bank'::text, x.id::text, (x.period_label)::text, nullif((x.status)::text,''), '/dashboard/expenses?tab=bank'::text, (x.period_label)::text
      from bank_statements x
      where concat_ws(' ', x.id,x.period_label) ilike pat
      order by (lower(x.id::text) = lower(trim(term))) desc, 4 limit per_type) s17;
  end if;
  if (r_full or 'expenses-bank' = any(r_mods)) then
    return query select * from (select 'Check'::text, 'expenses-bank'::text, x.id::text, (coalesce(x.particulars,x.id))::text, nullif((concat_ws(' · ', 'CHK '||x.check_number, x.status))::text,''), '/dashboard/expenses?tab=bank'::text, (coalesce(x.check_number,x.id))::text
      from outstanding_checks x
      where concat_ws(' ', x.id,x.particulars,x.check_number,x.notes,x.status) ilike pat
      order by (lower(x.id::text) = lower(trim(term))) desc, 4 limit per_type) s18;
  end if;
  if (r_full or 'expenses-pcf' = any(r_mods)) then
    return query select * from (select 'Petty Cash Voucher'::text, 'expenses-pcf'::text, x.id::text::text, (coalesce(x.pcv_number,x.id::text))::text, nullif((concat_ws(' · ', x.payee, x.date::text))::text,''), '/dashboard/expenses?tab=pcf'::text, (coalesce(x.pcv_number,x.payee))::text
      from petty_cash_vouchers x
      where concat_ws(' ', x.pcv_number,x.payee,x.notes) ilike pat
      order by (lower(x.id::text::text) = lower(trim(term))) desc, 4 limit per_type) s19;
  end if;
  if (r_full or 'purchasing' = any(r_mods)) then
    return query select * from (select 'Material Request'::text, 'purchasing'::text, x.id::text::text, (x.material_name)::text, nullif((concat_ws(' · ', 'PO '||x.po_number, x.status, x.requested_by))::text,''), '/dashboard/purchasing'::text, (x.material_name)::text
      from material_requests x
      where concat_ws(' ', x.id::text,x.material_name,x.dimension,x.po_number,x.project_reference,x.requested_by,x.status,x.notes,x.quotation_id) ilike pat
      order by (lower(x.id::text::text) = lower(trim(term))) desc, 4 limit per_type) s20;
  end if;
  if (r_full or 'purchasing' = any(r_mods)) then
    return query select * from (select 'Supplier Quote'::text, 'purchasing'::text, x.id::text::text, (s.name||' — '||coalesce(r.material_name,''))::text, nullif((concat_ws(' · ', 'PO '||r.po_number, case when x.selected then 'Selected' end))::text,''), '/dashboard/purchasing'::text, (s.name)::text
      from supplier_quotes x join suppliers s on s.id=x.supplier_id left join material_requests r on r.id=x.material_request_id
      where concat_ws(' ', s.name,r.material_name,r.po_number,x.notes) ilike pat
      order by (lower(x.id::text::text) = lower(trim(term))) desc, 4 limit per_type) s21;
  end if;
  if (r_full or 'purchasing' = any(r_mods)) then
    return query select * from (select 'Purchase Order'::text, 'purchasing'::text, x.id::text, (x.id)::text, nullif((concat_ws(' · ', s.name, 'Client PO '||x.po_number, x.status))::text,''), '/dashboard/purchasing'::text, (x.id)::text
      from purchase_orders x left join suppliers s on s.id=x.supplier_id
      where concat_ws(' ', x.id,x.po_number,x.status,x.notes,x.approved_by,s.name) ilike pat
      order by (lower(x.id::text) = lower(trim(term))) desc, 4 limit per_type) s22;
  end if;
  if (r_full or 'purchasing' = any(r_mods)) then
    return query select * from (select 'PO Line'::text, 'purchasing'::text, x.id::text, (x.material_name)::text, nullif((concat_ws(' · ', p.id, 'PO '||p.po_number))::text,''), '/dashboard/purchasing'::text, (p.id)::text
      from purchase_order_items x join purchase_orders p on p.id=x.purchase_order_id
      where concat_ws(' ', x.material_name,x.dimension,x.purchase_order_id) ilike pat
      order by (lower(x.id::text) = lower(trim(term))) desc, 4 limit per_type) s23;
  end if;
  if (r_full or 'purchasing' = any(r_mods)) then
    return query select * from (select 'Supplier Invoice'::text, 'purchasing'::text, x.id::text::text, (coalesce(x.invoice_number,x.sales_invoice_number,x.id::text))::text, nullif((concat_ws(' · ', x.purchase_order_id, 'Sales Inv '||x.sales_invoice_number, x.payment_method))::text,''), '/dashboard/purchasing'::text, (coalesce(x.invoice_number,x.sales_invoice_number))::text
      from purchase_order_invoices x
      where concat_ws(' ', x.invoice_number,x.sales_invoice_number,x.purchase_order_id,x.expense_id) ilike pat
      order by (lower(x.id::text::text) = lower(trim(term))) desc, 4 limit per_type) s24;
  end if;
  if (r_full or 'purchasing' = any(r_mods)) then
    return query select * from (select 'Supplier'::text, 'purchasing'::text, x.id::text::text, (x.name)::text, nullif((concat_ws(' · ', x.contact_person, x.address))::text,''), '/dashboard/purchasing'::text, (x.name)::text
      from suppliers x
      where concat_ws(' ', x.name,x.contact_person,x.address) ilike pat
      order by (lower(x.id::text::text) = lower(trim(term))) desc, 4 limit per_type) s25;
  end if;
  if (r_full or 'purchasing' = any(r_mods)) then
    return query select * from (select 'Supplier Material'::text, 'purchasing'::text, x.id::text::text, (x.material_name)::text, nullif((s.name)::text,''), '/dashboard/purchasing'::text, (x.material_name)::text
      from supplier_materials x join suppliers s on s.id=x.supplier_id
      where concat_ws(' ', x.material_name,s.name) ilike pat
      order by (lower(x.id::text::text) = lower(trim(term))) desc, 4 limit per_type) s26;
  end if;
  if (r_full or 'inventory' = any(r_mods)) then
    return query select * from (select 'Material'::text, 'inventory'::text, x.id::text, (x.name)::text, nullif((concat_ws(' · ', x.id, x.supplier, x.category))::text,''), '/dashboard/inventory'::text, (x.id)::text
      from inventory x
      where concat_ws(' ', x.id,x.name,x.supplier,x.category) ilike pat
      order by (lower(x.id::text) = lower(trim(term))) desc, 4 limit per_type) s27;
  end if;
  if (r_full or 'inventory' = any(r_mods)) then
    return query select * from (select 'Receipt'::text, 'inventory'::text, x.id::text::text, (x.material_name)::text, nullif((concat_ws(' · ', x.date::text, 'PO '||x.po_number, x.supplier, x.purchase_order_id))::text,''), '/dashboard/inventory'::text, (x.material_name)::text
      from material_replenishments x
      where concat_ws(' ', x.material_name,x.supplier,x.po_number,x.purchase_order_id,x.notes,x.material_id) ilike pat
      order by (lower(x.id::text::text) = lower(trim(term))) desc, 4 limit per_type) s28;
  end if;
  if (r_full or 'inventory' = any(r_mods)) then
    return query select * from (select 'Release'::text, 'inventory'::text, x.id::text::text, (x.material_name)::text, nullif((concat_ws(' · ', x.date::text, 'PO '||x.po_number, x.requestor))::text,''), '/dashboard/inventory'::text, (x.material_name)::text
      from material_releases x
      where concat_ws(' ', x.material_name,x.requestor,x.po_number,x.notes,x.material_id) ilike pat
      order by (lower(x.id::text::text) = lower(trim(term))) desc, 4 limit per_type) s29;
  end if;
  if (r_full or 'inventory' = any(r_mods)) then
    return query select * from (select 'Excess Return'::text, 'inventory'::text, x.id::text::text, (x.material_name)::text, nullif((concat_ws(' · ', x.date::text, 'PO '||x.po_number))::text,''), '/dashboard/inventory'::text, (x.material_name)::text
      from material_excess_returns x
      where concat_ws(' ', x.material_name,x.po_number,x.notes,x.material_id) ilike pat
      order by (lower(x.id::text::text) = lower(trim(term))) desc, 4 limit per_type) s30;
  end if;
  if (r_full or 'resources' = any(r_mods)) then
    return query select * from (select 'Equipment'::text, 'resources'::text, x.id::text, (x.name)::text, nullif((concat_ws(' · ', x.brand, x.status, x.assigned_to))::text,''), '/dashboard/resources'::text, (x.id)::text
      from equipment x
      where concat_ws(' ', x.id,x.name,x.brand,x.status,x.assigned_to) ilike pat
      order by (lower(x.id::text) = lower(trim(term))) desc, 4 limit per_type) s31;
  end if;
  if (r_full or 'resources' = any(r_mods)) then
    return query select * from (select 'Equipment Assignment'::text, 'resources'::text, x.id::text::text, (coalesce(e.name,x.equipment_id)||' → PO '||x.po_number)::text, nullif((concat_ws(' · ', x.operator_name, x.start_date::text))::text,''), '/dashboard/resources'::text, (x.po_number)::text
      from equipment_assignments x left join equipment e on e.id=x.equipment_id
      where concat_ws(' ', e.name,x.equipment_id,x.po_number,x.operator_name,x.notes) ilike pat
      order by (lower(x.id::text::text) = lower(trim(term))) desc, 4 limit per_type) s32;
  end if;
  if (r_full or 'resources' = any(r_mods)) then
    return query select * from (select 'Equipment Loan'::text, 'resources'::text, x.id::text, (x.id)::text, nullif((concat_ws(' · ', e.name, x.vendor, x.status))::text,''), '/dashboard/resources'::text, (x.id)::text
      from equipment_loans x left join equipment e on e.id=x.equipment_id
      where concat_ws(' ', x.id,e.name,x.vendor,x.notes,x.status) ilike pat
      order by (lower(x.id::text) = lower(trim(term))) desc, 4 limit per_type) s33;
  end if;
  if (r_full or 'access' = any(r_mods)) then
    return query select * from (select 'User'::text, 'access'::text, x.id::text::text, (coalesce(x.full_name,x.username))::text, nullif((concat_ws(' · ', x.username, x.role, x.status))::text,''), '/dashboard/access'::text, (coalesce(x.full_name,x.username))::text
      from profiles x
      where concat_ws(' ', x.full_name,x.username,x.role) ilike pat
      order by (lower(x.id::text::text) = lower(trim(term))) desc, 4 limit per_type) s34;
  end if;
  if (r_full or 'audit' = any(r_mods)) then
    return query select * from (select 'Audit Entry'::text, 'audit'::text, x.id::text::text, (x.action||' '||x.table_name||' '||x.record_id)::text, nullif((concat_ws(' · ', x.changed_by_name, x.changed_at::date::text))::text,''), '/dashboard/audit-log'::text, (x.record_id)::text
      from audit_log x
      where concat_ws(' ', x.table_name,x.record_id,x.action,x.changed_by_name) ilike pat
      order by (lower(x.id::text::text) = lower(trim(term))) desc, 4 limit per_type) s35;
  end if;
end $fn$;

revoke all on function public.global_search(text, int) from public, anon;
grant execute on function public.global_search(text, int) to authenticated;
