-- =====================================================================
-- 05_traceability.sql — hash-chained audit trail + source links
--
-- Every money or material event (invoice issued, collection, supplier PO,
-- supplier invoice/payment, expense, bank deposit/withdrawal, material
-- release, payroll run) is appended to ledger_chain as a "block":
--   * parents  → the earlier records this event came from
--   * payload  → snapshot of the fields that matter
--   * prev_hash/hash → SHA-256 chain, so any later edit or deletion of a
--                      source record (or of the chain) is detectable.
--   * edits/deletions of a sealed record are NOT silent: they append an
--     'Amendment' / 'Deletion' block, so history is preserved.
-- verify_ledger_chain() re-checks all of it. Safe to re-run.
-- =====================================================================

-- 1. Source / project references on the money tables ------------------
alter table expenses          add column if not exists po_number   text;  -- client PO / project the cost belongs to
alter table expenses          add column if not exists source_type text;  -- 'PO Payment' | 'Payroll' | 'Petty Cash' | 'Supplier Receipt' | 'Billing Statement' ...
alter table expenses          add column if not exists source_id   text;  -- id of the originating record or document no.
alter table bank_transactions add column if not exists po_number   text;
alter table bank_transactions add column if not exists source_type text;  -- 'Invoice' | 'Expense' | 'PO Payment' | 'Payroll' | 'Petty Cash' | 'Bank Memo' ...
alter table bank_transactions add column if not exists source_id   text;

-- 2. The chain ----------------------------------------------------------
create table if not exists ledger_chain (
  seq        bigserial primary key,
  block_type text   not null,
  ref_table  text   not null,
  ref_id     text   not null,
  amount     numeric,
  po_number  text,
  parents    jsonb  not null default '[]'::jsonb,   -- [{"t":"table","id":"..."}]
  payload    jsonb  not null,
  prev_hash  text   not null,
  hash       text   not null,
  created_at timestamptz not null default now()
);
create index if not exists ledger_chain_ref_idx on ledger_chain (ref_table, ref_id);
create index if not exists ledger_chain_po_idx  on ledger_chain (po_number);

alter table ledger_chain enable row level security;
drop policy if exists ledger_chain_read on ledger_chain;
create policy ledger_chain_read on ledger_chain for select to authenticated using (true);

-- Append-only: normal sessions cannot rewrite history.
create or replace function ledger_chain_guard() returns trigger language plpgsql as $$
begin
  raise exception 'ledger_chain is append-only';
end $$;
drop trigger if exists ledger_chain_no_change on ledger_chain;
create trigger ledger_chain_no_change before update or delete on ledger_chain
  for each row execute function ledger_chain_guard();

-- 3. Which fields of each source table are sealed into a block ----------
--    Only facts that should not change quietly (not workflow status).
create or replace function ledger_fields(tbl text, stream text default 'r') returns text[] language sql immutable as $$
  select case
    when tbl = 'invoices' and stream = 'c' then array['id','po_number','collection_date','collection_amount']
    when tbl = 'invoices'                  then array['id','client','date','po_number','quotation_id','vat_mode']
    when tbl = 'purchase_orders'           then array['id','supplier_id','po_number','date_released']
    when tbl = 'purchase_order_invoices'   then array['id','purchase_order_id','invoice_number','sales_invoice_number','amount','date','expense_id']
    when tbl = 'expenses'                  then array['id','date','category','amount','po_number','source_type','source_id','receipt']
    when tbl = 'bank_transactions'         then array['id','bank_statement_id','date','amount','direction','category','invoice_id','expense_id','po_number','source_type','source_id']
    when tbl = 'material_releases'         then array['id','material_id','qty','date','po_number','bom_id','source']
    when tbl = 'payroll_runs'              then array['id','period_start','period_end']
    else array['id']
  end
$$;

-- stream: 'c' = invoice collection facts, 'r' = the record itself
create or replace function ledger_stream(btype text) returns text language sql immutable as $$
  select case when btype in ('Collection','Collection Amendment') then 'c' else 'r' end
$$;

create or replace function ledger_snapshot(tbl text, rid text, stream text default 'r') returns jsonb language plpgsql stable as $$
declare j jsonb;
begin
  execute format('select to_jsonb(t) from %I t where t.id::text = %L', tbl, rid) into j;
  if j is null then return null; end if;
  return (select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from jsonb_each(j) e(k, v) where k = any (ledger_fields(tbl, stream)));
end $$;

create or replace function ledger_hash(prev text, btype text, tbl text, rid text, amt numeric, par jsonb, pay jsonb) returns text language sql immutable as $$
  select encode(sha256(convert_to(prev||'|'||btype||'|'||tbl||'|'||rid||'|'||coalesce(amt::text,'')||'|'||par::text||'|'||pay::text, 'UTF8')), 'hex')
$$;

-- 4. Append one block ---------------------------------------------------
create or replace function ledger_append(btype text, tbl text, rid text, amt numeric, po text, par jsonb, explicit jsonb default null)
returns void language plpgsql security definer set search_path = public as $$
declare prev text; pay jsonb;
begin
  perform pg_advisory_xact_lock(884201);   -- one writer at a time keeps the chain linear
  select hash into prev from ledger_chain order by seq desc limit 1;
  prev := coalesce(prev, repeat('0', 64));
  pay  := coalesce(explicit, ledger_snapshot(tbl, rid, ledger_stream(btype)));
  if pay is null then return; end if;
  insert into ledger_chain (block_type, ref_table, ref_id, amount, po_number, parents, payload, prev_hash, hash)
  values (btype, tbl, rid, amt, po, coalesce(par, '[]'::jsonb), pay, prev,
          ledger_hash(prev, btype, tbl, rid, amt, coalesce(par, '[]'::jsonb), pay));
end $$;

-- helper: build a parents array, skipping nulls
create or replace function ledger_parents(variadic items text[]) returns jsonb language sql immutable as $$
  select coalesce(jsonb_agg(jsonb_build_object('t', split_part(i, ':', 1), 'id', substr(i, position(':' in i) + 1))), '[]'::jsonb)
  from unnest(items) i where i is not null and i <> '' and i not like '%:' and i not like '%:null'
$$;

-- map an expense/bank source_type to the table that holds the originating record
create or replace function ledger_source_table(st text) returns text language sql immutable as $$
  select case st
    when 'PO Payment'  then 'purchase_order_invoices'
    when 'Payroll'     then 'payroll_runs'
    when 'Petty Cash'  then 'petty_cash_periods'
    when 'Invoice'     then 'invoices'
    when 'Expense'     then 'expenses'
    when 'Petty Cash Voucher' then 'petty_cash_vouchers'
    when 'Material Release'   then 'material_releases'
    when 'Cash Advance'       then 'cash_advances'
    when 'Check'              then 'outstanding_checks'
    else null end
$$;

-- 5. Per-table event builders (used by both triggers and backfill) -------
create or replace function ledger_event(tbl text, rid text) returns void language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if tbl = 'invoices' then
    select * into r from invoices where id = rid;
    perform ledger_append('Invoice Issued', 'invoices', rid, null, r.po_number,
      ledger_parents('quotations:'||r.quotation_id, 'projects:'||(select p.id from projects p where p.po_number = r.po_number limit 1)));
  elsif tbl = 'collection' then
    select * into r from invoices where id = rid;
    perform ledger_append('Collection', 'invoices', rid, r.collection_amount, r.po_number, ledger_parents('invoices:'||rid));
  elsif tbl = 'purchase_orders' then
    select * into r from purchase_orders where id = rid;
    perform ledger_append('PO Issued', 'purchase_orders', rid, null, r.po_number,
      ledger_parents('projects:'||(select p.id from projects p where p.po_number = r.po_number limit 1)));
  elsif tbl = 'purchase_order_invoices' then
    select i.*, o.po_number as po from purchase_order_invoices i join purchase_orders o on o.id = i.purchase_order_id where i.id::text = rid into r;
    perform ledger_append(case when r.expense_id is null then 'Supplier Invoice' else 'Supplier Payment' end, 'purchase_order_invoices', rid, r.amount, r.po,
      ledger_parents('purchase_orders:'||r.purchase_order_id));
  elsif tbl = 'expenses' then
    select * into r from expenses where id = rid;
    perform ledger_append('Expense', 'expenses', rid, r.amount, r.po_number,
      ledger_parents(coalesce(ledger_source_table(r.source_type),'documents')||':'||r.source_id,
                     'projects:'||(select p.id from projects p where p.po_number = r.po_number limit 1)));
  elsif tbl = 'bank_transactions' then
    select * into r from bank_transactions where id = rid;
    perform ledger_append(case when r.direction = 'Deposit' then 'Bank Deposit' else 'Bank Withdrawal' end, 'bank_transactions', rid, r.amount, r.po_number,
      ledger_parents('invoices:'||r.invoice_id, 'expenses:'||r.expense_id,
                     case when r.expense_id is null then coalesce(ledger_source_table(r.source_type),'documents')||':'||r.source_id end));
  elsif tbl = 'material_releases' then
    select * into r from material_releases where id::text = rid;
    perform ledger_append('Material Release', 'material_releases', rid, null, r.po_number,
      ledger_parents('inventory:'||r.material_id, 'project_bom:'||r.bom_id::text,
                     'projects:'||(select p.id from projects p where p.po_number = r.po_number limit 1)));
  elsif tbl = 'payroll_runs' then
    perform ledger_append('Payroll Run', 'payroll_runs', rid, null, null, '[]'::jsonb);
  end if;
end $$;

-- 6. Triggers: new activity is sealed; edits/deletions are appended, never silent
create or replace function ledger_latest(tbl text, rid text, stream text) returns ledger_chain language sql stable as $$
  select c.* from ledger_chain c where c.ref_table = tbl and c.ref_id = rid and ledger_stream(c.block_type) = stream
  order by c.seq desc limit 1
$$;

create or replace function ledger_trg() returns trigger language plpgsql security definer set search_path = public as $$
declare rid text; live jsonb; last ledger_chain; amt numeric; po text;
begin
  if TG_OP = 'INSERT' then
    perform ledger_event(TG_TABLE_NAME, NEW.id::text);
    return null;
  end if;

  if TG_OP = 'DELETE' then
    rid := OLD.id::text;
    for last in select * from ledger_chain c where c.ref_table = TG_TABLE_NAME and c.ref_id = rid order by c.seq desc loop
      if last.block_type in ('Deletion') then exit; end if;
      perform ledger_append('Deletion', TG_TABLE_NAME, rid, last.amount, last.po_number, jsonb_build_array(jsonb_build_object('t','ledger_chain','id',last.seq::text)), last.payload);
      exit;
    end loop;
    return null;
  end if;

  -- UPDATE
  rid := NEW.id::text;
  live := ledger_snapshot(TG_TABLE_NAME, rid, 'r');
  last := ledger_latest(TG_TABLE_NAME, rid, 'r');
  if last.seq is not null and live is distinct from last.payload and last.block_type <> 'Deletion' then
    perform ledger_append('Amendment', TG_TABLE_NAME, rid, last.amount, last.po_number, jsonb_build_array(jsonb_build_object('t','ledger_chain','id',last.seq::text)));
  end if;
  if TG_TABLE_NAME = 'invoices' then
    if (to_jsonb(NEW)->>'status') = 'Paid' and (to_jsonb(NEW)->>'collection_date') is not null then
      live := ledger_snapshot('invoices', rid, 'c');
      last := ledger_latest('invoices', rid, 'c');
      if last.seq is null then
        perform ledger_event('collection', rid);
      elsif live is distinct from last.payload then
        perform ledger_append('Collection Amendment', 'invoices', rid, (to_jsonb(NEW)->>'collection_amount')::numeric, to_jsonb(NEW)->>'po_number', jsonb_build_array(jsonb_build_object('t','ledger_chain','id',last.seq::text)));
      end if;
    end if;
  end if;
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array['invoices','purchase_orders','purchase_order_invoices','expenses','bank_transactions','material_releases','payroll_runs'] loop
    execute format('drop trigger if exists ledger_seal_ins on %I', t);
    execute format('drop trigger if exists ledger_seal_upd on %I', t);
    execute format('drop trigger if exists ledger_seal_del on %I', t);
    execute format('create trigger ledger_seal_ins after insert on %I for each row execute function ledger_trg()', t);
    execute format('create trigger ledger_seal_upd after update on %I for each row execute function ledger_trg()', t);
    execute format('create trigger ledger_seal_del after delete on %I for each row execute function ledger_trg()', t);
  end loop;
end $$;

-- 7. Verification: links, hashes, and that every live record still matches
--    the latest block sealed for it (or was deleted with a Deletion block).
create or replace function verify_ledger_chain()
returns table (seq bigint, ref_table text, ref_id text, problem text)
language plpgsql stable security definer set search_path = public as $$
declare b record; prev text := repeat('0', 64); live jsonb;
begin
  for b in select * from ledger_chain c order by c.seq loop
    if b.prev_hash <> prev then
      seq := b.seq; ref_table := b.ref_table; ref_id := b.ref_id; problem := 'Chain link broken (a block was removed or altered)'; return next;
    end if;
    if b.hash <> ledger_hash(b.prev_hash, b.block_type, b.ref_table, b.ref_id, b.amount, b.parents, b.payload) then
      seq := b.seq; ref_table := b.ref_table; ref_id := b.ref_id; problem := 'Block contents do not match their hash'; return next;
    end if;
    prev := b.hash;
  end loop;
  -- latest block per record/stream must agree with the live record
  for b in
    select distinct on (c.ref_table, c.ref_id, ledger_stream(c.block_type)) c.*
      from ledger_chain c order by c.ref_table, c.ref_id, ledger_stream(c.block_type), c.seq desc
  loop
    live := ledger_snapshot(b.ref_table, b.ref_id, ledger_stream(b.block_type));
    if b.block_type = 'Deletion' then
      if live is not null then
        seq := b.seq; ref_table := b.ref_table; ref_id := b.ref_id; problem := 'Record was deleted, then reappeared without a block'; return next;
      end if;
    elsif live is null then
      seq := b.seq; ref_table := b.ref_table; ref_id := b.ref_id; problem := 'Record is missing but no Deletion was sealed (removed outside the app)'; return next;
    elsif live is distinct from b.payload then
      seq := b.seq; ref_table := b.ref_table; ref_id := b.ref_id; problem := 'Record changed without an Amendment block (edited outside the app)'; return next;
    end if;
  end loop;
end $$;

-- 8. Activity that has nothing to fall back on ---------------------------
create or replace view ledger_untraced as
  select 'Expense'::text as kind, e.id::text as ref_id, e.date, e.amount, e.description as detail,
         'No source record and no receipt/document number'::text as reason
    from expenses e where coalesce(e.source_id,'') = '' and coalesce(e.receipt,'') = ''
  union all
  select 'Bank Withdrawal', b.id, b.date, b.amount, b.particulars,
         'Not linked to an expense, payroll, petty cash or other source'
    from bank_transactions b where b.direction = 'Withdrawal' and b.expense_id is null and coalesce(b.source_id,'') = ''
  union all
  select 'Bank Deposit', b.id, b.date, b.amount, b.particulars,
         'Not linked to an invoice or bank memo'
    from bank_transactions b where b.direction = 'Deposit' and b.invoice_id is null and coalesce(b.source_id,'') = '';

-- 9. (Re)build the whole chain from existing records, oldest first --------
--    Admin use only (see grants below). New activity is sealed by triggers.
create or replace function ledger_rebuild() returns bigint language plpgsql security definer set search_path = public as $$
declare r record; n bigint;
begin
  alter table ledger_chain disable trigger ledger_chain_no_change;
  truncate ledger_chain restart identity;
  alter table ledger_chain enable trigger ledger_chain_no_change;
  for r in
    select kind, rid from (
      select 'invoices' kind, id::text rid, coalesce(date, created_at::date) d, 1 p from invoices
      union all select 'collection', id::text, collection_date, 2 from invoices where status = 'Paid' and collection_date is not null
      union all select 'purchase_orders', id::text, date_released, 3 from purchase_orders
      union all select 'purchase_order_invoices', i.id::text, i.date, 4 from purchase_order_invoices i
      union all select 'payroll_runs', id::text, period_end, 5 from payroll_runs
      union all select 'expenses', id::text, date, 6 from expenses
      union all select 'bank_transactions', id::text, date, 7 from bank_transactions
      union all select 'material_releases', id::text, date, 8 from material_releases
    ) x order by d, p, rid
  loop
    perform ledger_event(r.kind, r.rid);
  end loop;
  select count(*) into n from ledger_chain;
  return n;
end $$;

revoke all on function ledger_rebuild() from public, anon, authenticated;
revoke all on function ledger_append(text,text,text,numeric,text,jsonb,jsonb) from public, anon, authenticated;
revoke all on function ledger_event(text,text) from public, anon, authenticated;
grant execute on function verify_ledger_chain() to authenticated;
grant select on ledger_untraced to authenticated;

-- Seal everything that already exists (only on first run)
do $$ begin
  if (select count(*) from ledger_chain) = 0 then perform ledger_rebuild(); end if;
end $$;
