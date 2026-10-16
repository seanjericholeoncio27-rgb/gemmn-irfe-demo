-- 10_rebuild_operations_linked.sql
-- Rebuilds the demo's operational chain so every record traces to the one before it,
-- the same way the real app produces them (run 09_real_system_parity.sql FIRST):
--
--   Quotation (material lines) -> Project BOM -> Material Request -> Supplier Quotes
--   -> Supplier PO -> Receiving (stock +) -> Release / BOM fulfilment (stock -) ->
--   Excess Return -> Supplier Invoice -> Payment (Expense) -> Bank Withdrawal
--   Client Invoice -> Collection -> Bank Deposit      ... all feeding the Ledger chain.
--
-- Stock, timeline entries, BOM progress and project values are produced by the real
-- database triggers installed in 09, not hand-typed. Safe to re-run (it clears and
-- rebuilds the purchasing/receiving/release/material-expense data only).

begin;

-- ════════════════════════════════════════════════════════════════════════════
-- 0. CLEAR the hand-seeded purchasing/inventory-movement data
--    (triggers paused ONLY while clearing so stock isn't "reversed" row by row)
-- ════════════════════════════════════════════════════════════════════════════
alter table material_releases        disable trigger user;
alter table material_excess_returns  disable trigger user;
alter table material_replenishments  disable trigger user;
alter table project_timeline         disable trigger user;
alter table expenses                 disable trigger user;
alter table bank_transactions        disable trigger user;
alter table purchase_orders          disable trigger user;

delete from bank_transactions where expense_id in (select id from expenses where category = 'Materials/BOM');
delete from purchase_order_invoices;
update material_releases set excess_return_id = null;
delete from material_excess_returns;
delete from material_releases;
delete from material_replenishments;
delete from purchase_order_items;
delete from purchase_orders;
delete from supplier_quotes;
delete from material_requests;
delete from project_bom;
delete from project_item_quantities;
delete from expenses where category = 'Materials/BOM';
delete from project_timeline;

alter table material_releases        enable trigger user;
alter table material_excess_returns  enable trigger user;
alter table material_replenishments  enable trigger user;
alter table project_timeline         enable trigger user;
alter table expenses                 enable trigger user;
alter table bank_transactions        enable trigger user;
alter table purchase_orders          enable trigger user;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Quotations: materials sit under their item, names match the Materials Registry
-- ════════════════════════════════════════════════════════════════════════════
update quotation_items set position = position + 1000
 where kind = 'note' and position < 1000
   and quotation_id in (select id from quotations where po_number is not null);

create temp table matmap (qkey text primary key, inv_id text, inv_name text, unit text, supplier text, cat text, is_new boolean);
insert into matmap values
 ('SUS304 SHEET 1.2MM','MAT-001','SUS304 Sheet 1.2mm 4x8','SHT','Prime Metals Supply','Steel',false),
 ('SUS304 SHEET 1.5MM','MAT-002','SUS304 Sheet 1.5mm 4x8','SHT','Prime Metals Supply','Steel',false),
 ('SUS304 SHEET 2.0MM','MAT-003','SUS304 Sheet 2.0mm 4x8','SHT','Prime Metals Supply','Steel',false),
 ('SUS304 SQ. TUBE 1-1/2"','MAT-004','SUS304 Sq. Tube 1-1/2" 6m','LGTH','Prime Metals Supply','Steel',false),
 ('SUS304 ANGLE BAR 2"','MAT-005','SUS304 Angle Bar 2" 6m','LGTH','Prime Metals Supply','Steel',false),
 ('GI PIPE 1-1/2" SCH40','MAT-006','GI Pipe 1-1/2" 6m','LGTH','Ironworks Trading','Steel',false),
 ('STEEL ANGLE BAR 2"x2"','MAT-007','Steel Angle Bar 2"x2" 6m','LGTH','Ironworks Trading','Steel',false),
 ('CHECKERED PLATE 3MM','MAT-008','Checkered Plate 3mm 4x8','SHT','Ironworks Trading','Steel',false),
 ('ANCHOR BOLT 1/2"','MAT-016','Anchor Bolt 1/2"','PCS','Hardware Depot','Hardware',false),
 ('MARINE PLYWOOD 3/4"','MAT-020','Marine Plywood 3/4"','SHT','Ironworks Trading','Wood',false),
 ('NYLON ROLLER','MAT-018','Nylon Roller','PCS','Hardware Depot','Hardware',false),
 ('STEEL PRIMER PAINT','MAT-015','Primer Paint (gal)','GAL','Hardware Depot','Paint',false),
 ('ADJUSTABLE LEG','MAT-017','Adjustable Leg SS','PCS','Prime Metals Supply','Hardware',false),
 ('BUTTERFLY VALVE','MAT-019','Butterfly Valve 1-1/2"','PCS','Prime Metals Supply','Hardware',false),
 ('GI WIRE MESH','MAT-021','GI Wire Mesh','SHT','Hardware Depot','Steel',true),
 ('STEEL ANGLE BAR 1"','MAT-022','Steel Angle Bar 1" 6m','LGTH','Ironworks Trading','Steel',true),
 ('SUS304 ROUND BAR 1/2"','MAT-023','SUS304 Round Bar 1/2" 6m','LGTH','Prime Metals Supply','Steel',true),
 ('SUS304 ELBOW 1-1/2"','MAT-024','SUS304 Elbow 1-1/2"','PCS','Prime Metals Supply','Hardware',true),
 ('SUS304 FERRULE 1-1/2"','MAT-025','SUS304 Ferrule 1-1/2"','PCS','Prime Metals Supply','Hardware',true),
 ('SUS304 FLAT BAR 1"','MAT-026','SUS304 Flat Bar 1" 6m','LGTH','Prime Metals Supply','Steel',true),
 ('SUS304 SQ. TUBE 2"','MAT-027','SUS304 Sq. Tube 2" 6m','LGTH','Prime Metals Supply','Steel',true);

insert into inventory (id, name, unit, quantity, min_stock, unit_cost, supplier, category)
select m.inv_id, m.inv_name, m.unit, 0, 4,
       coalesce((select round(avg(qi.price)) from quotation_items qi where qi.kind='material' and upper(qi.description)=m.qkey), 0),
       m.supplier, m.cat
from matmap m where m.is_new
on conflict (id) do nothing;

update quotation_items qi set description = upper(m.inv_name), unit = m.unit
from matmap m
where qi.kind = 'material' and upper(qi.description) = m.qkey
  and qi.quotation_id in (select id from quotations where po_number is not null);

-- ════════════════════════════════════════════════════════════════════════════
update quotations set job_order_number = case id when 'QT-2026-013' then '20260810001' when 'QT-2026-005' then '20260920001' when 'QT-2026-012' then '20260921001' when 'QT-2026-015' then '20260929001' end
 where id in ('QT-2026-013','QT-2026-005','QT-2026-012','QT-2026-015');

-- 2. BOM from the attached quotations (what "attach quotation to PO" does in the app)
-- ════════════════════════════════════════════════════════════════════════════
insert into project_item_quantities (po_number, quotation_id, item_line_uid, description, quoted_qty, po_qty)
select q.po_number, q.id, i.line_uid, i.description, i.qty, i.qty
from quotations q join quotation_items i on i.quotation_id = q.id and i.kind = 'item'
where q.po_number is not null;

insert into project_bom (id, po_number, source_quotation_id, source_line_uid, description, dimension,
                         qty_needed, unit, estimated_unit_cost, status, qty_purchased)
select md5('bom|' || q.po_number || '|' || m.line_uid)::uuid, q.po_number, q.id, m.line_uid, m.description, coalesce(m.dimension, ''),
       m.qty, m.unit, m.price, 'Not Purchased', 0
from quotations q join quotation_items m on m.quotation_id = q.id and m.kind = 'material'
where q.po_number is not null
  and exists (select 1 from quotation_items i where i.quotation_id = q.id and i.kind = 'item' and i.position < m.position);

-- ════════════════════════════════════════════════════════════════════════════
-- 3. Procurement plan (who buys what, when) -- drives everything below
-- ════════════════════════════════════════════════════════════════════════════
create temp table poplan (po text primary key, mr date, qd date, spo date, recv date, paid date, rel_pct numeric, mode text, expd date);
insert into poplan values
 ('PO-2026-0101','2026-07-30','2026-08-01','2026-08-03','2026-08-11','2026-08-25',0.7,'bought','2026-08-10'),
 ('PO-2026-0102','2026-08-05','2026-08-08','2026-08-12',null,null,0,'ordered','2026-09-02'),
 ('PO-2026-0103','2026-08-01','2026-08-02','2026-08-04','2026-08-10','2026-09-04',1,'bought','2026-08-09'),
 ('PO-2026-0104','2026-08-06','2026-08-08','2026-08-10','2026-08-14','2026-09-11',1,'bought','2026-08-13'),
 ('PO-2026-0105','2026-09-02','2026-09-04','2026-09-08','2026-09-15','2026-10-08',0.5,'bought','2026-09-14'),
 ('PO-2026-0106','2026-09-05','2026-09-07','2026-09-09','2026-09-14',null,1,'bought','2026-09-13'),
 ('PO-2026-0107','2026-09-25','2026-09-27',null,null,null,0,'quoting',null),
 ('PO-2026-0108','2026-08-13','2026-08-14','2026-08-17','2026-08-22','2026-09-25',1,'bought','2026-08-21');

create temp table L as
select b.id as bom_id, b.po_number as po, b.source_quotation_id as qid, b.source_line_uid as luid,
       b.description as descr, b.dimension as dim, b.unit, b.qty_needed as qty, b.estimated_unit_cost as est,
       m.inv_id, m.inv_name, s.id as supplier_id, s.name as supplier_name,
       (select qi.position from quotation_items qi where qi.quotation_id = b.source_quotation_id and qi.line_uid = b.source_line_uid) as pos,
       pr.manager, pr.name as project_name, p.rel_pct,
       case
         when b.po_number = 'PO-2026-0108' and b.source_quotation_id = 'QT-2026-005' then 'quoting'
         when b.po_number in ('PO-2026-0104','PO-2026-0108') and m.inv_id = 'MAT-017' then 'stock'
         else p.mode end as mode,
       case when b.po_number = 'PO-2026-0108' and b.source_quotation_id = 'QT-2026-005' then date '2026-09-22' else p.mr end as mr,
       case when b.po_number = 'PO-2026-0108' and b.source_quotation_id = 'QT-2026-005' then date '2026-09-24' else p.qd end as qd,
       p.spo, p.recv, p.paid, p.expd,
       round(b.estimated_unit_cost * 0.96, 2) as unit_price
from project_bom b
join matmap m on upper(m.inv_name) = upper(b.description)
join suppliers s on s.name = m.supplier
join poplan p on p.po = b.po_number
join projects pr on pr.po_number = b.po_number;

alter table L add column rn int, add column state text;
update L set rn = x.rn from (select bom_id, row_number() over (partition by po order by qid, pos) rn from L where mode = 'quoting') x where x.bom_id = L.bom_id;
update L set state = case mode when 'bought' then 'Fulfilled' when 'ordered' then 'PO Released'
                              when 'quoting' then case when rn <= 2 then 'Comparing' else 'Pending Quotes' end end;

-- ════════════════════════════════════════════════════════════════════════════
-- 4. Material requests (+ timeline "Material Requested" by trigger) and supplier quotes
-- ════════════════════════════════════════════════════════════════════════════
insert into material_requests (id, po_number, project_reference, bom_id, material_name, dimension, qty_needed, unit,
                               requested_by, date_requested, status, notes, quotation_id, quotation_line_uid)
select md5('mr|' || bom_id)::uuid, po, project_name, bom_id, descr, dim, qty, unit, manager, mr, state, null, qid, luid
from L where mode <> 'stock';

update project_bom b set status = 'Requested' from L where L.bom_id = b.id and L.mode in ('quoting','ordered');

-- losing / competing quote first, then the winning one (selected quotes log "Quote Approved")
insert into supplier_quotes (id, material_request_id, supplier_id, quoted_price, quoted_date, notes, selected)
select md5('sqa|' || bom_id)::uuid, md5('mr|' || bom_id)::uuid,
       (select s2.id from suppliers s2 where s2.id <> L.supplier_id order by md5(s2.name || L.bom_id::text) limit 1),
       round(est * 1.06, 2), qd, null, false
from L where mode in ('bought','ordered','quoting') and (mode <> 'quoting' or state = 'Comparing');

insert into supplier_quotes (id, material_request_id, supplier_id, quoted_price, quoted_date, notes, selected)
select md5('sqw|' || bom_id)::uuid, md5('mr|' || bom_id)::uuid, supplier_id, unit_price, qd, null, (mode <> 'quoting')
from L where mode in ('bought','ordered') or (mode = 'quoting' and state = 'Comparing');

-- ════════════════════════════════════════════════════════════════════════════
-- 5. Supplier purchase orders (one per project + supplier) and their lines
-- ════════════════════════════════════════════════════════════════════════════
create temp table spo as
select 'SPO-2026-' || lpad((row_number() over (order by min(spo), po, supplier_id))::text, 3, '0') as id,
       po, supplier_id, max(supplier_name) as supplier_name, min(spo) as d, min(expd) as expd, min(recv) as recv, min(paid) as paid,
       max(mode) as mode, round(sum(qty * unit_price), 2) as total
from L where mode in ('bought','ordered') group by po, supplier_id;

insert into purchase_orders (id, supplier_id, po_number, status, date_released, expected_delivery, notes, created_at,
                             approved_by, approved_at, amount_invoiced, payment_terms, amount_paid)
select id, supplier_id, po, case when mode = 'ordered' then 'Released' when paid is not null then 'Paid' else 'Invoiced' end,
       d, expd, null, d::timestamptz, 'Demo Admin', d::timestamptz,
       case when mode = 'ordered' then 0 else total end, '30 Days', case when paid is not null then total else 0 end
from spo;

insert into purchase_order_items (id, purchase_order_id, material_request_id, material_name, dimension, qty, qty_received, unit, unit_price, created_at)
select 'POI-' || s.id || '-' || row_number() over (partition by s.id order by l.qid, l.pos),
       s.id, md5('mr|' || l.bom_id)::uuid, l.descr, l.dim, l.qty,
       case when l.mode = 'bought' then l.qty else 0 end, l.unit, l.unit_price, s.d::timestamptz
from L l join spo s on s.po = l.po and s.supplier_id = l.supplier_id
where l.mode in ('bought','ordered');

-- ════════════════════════════════════════════════════════════════════════════
-- 6. Receiving (stock +, "Material Received" by trigger) and BOM fulfilment
-- ════════════════════════════════════════════════════════════════════════════
insert into material_replenishments (id, material_id, material_name, qty, unit_cost, supplier, po_number, purchase_order_id, date, notes)
select md5('rep|' || l.bom_id)::uuid, l.inv_id, l.inv_name, l.qty, l.unit_price, l.supplier_name, l.po, s.id, l.recv,
       'Received via Inventory from Supplier PO ' || s.id || ' — ' || l.descr
from L l join spo s on s.po = l.po and s.supplier_id = l.supplier_id
where l.mode = 'bought';

update project_bom b set qty_purchased = L.qty, status = 'Purchased' from L where L.bom_id = b.id and L.mode = 'bought';

-- ════════════════════════════════════════════════════════════════════════════
-- 7. Releases to the job (stock -, "Material Released" by trigger)
-- ════════════════════════════════════════════════════════════════════════════
insert into material_releases (id, material_id, material_name, qty, unit, requestor, po_number, date, notes, source, bom_id)
select md5('rel|' || bom_id)::uuid, inv_id, inv_name, greatest(1, least(qty, ceil(qty * rel_pct))), unit, manager, po,
       least(recv + 2, current_date), 'Requisition for fabrication — ' || descr, 'Fresh Stock', null
from L where mode = 'bought' and rel_pct > 0;

-- BOM lines fulfilled straight from existing stock (Projects > "Fulfill from stock")
insert into material_releases (id, material_id, material_name, qty, unit, requestor, po_number, date, notes, source, bom_id)
select md5('rel|' || bom_id)::uuid, inv_id, inv_name, qty, unit, 'Project ' || po || ' (BOM fulfillment)', po,
       case po when 'PO-2026-0104' then date '2026-08-12' else date '2026-08-18' end, 'BOM: ' || descr, 'Fresh Stock', bom_id::text
from L where mode = 'stock';

insert into expenses (id, date, category, description, amount, payment_method, receipt, status, po_number, source_type, source_id)
select 'EXP-11' || lpad((row_number() over (order by r.date, l.bom_id))::text, 2, '0'), r.date, 'Materials/BOM',
       l.inv_name || ' — ' || l.qty || ' ' || l.unit || ' for PO ' || l.po || ' (from existing stock)',
       l.qty * i.unit_cost, 'Internal Transfer', 'REL-' || r.id, 'Paid', l.po, 'Material Release', r.id::text
from L l join material_releases r on r.id = md5('rel|' || l.bom_id)::uuid join inventory i on i.id = l.inv_id
where l.mode = 'stock';

update project_bom b set qty_purchased = L.qty, status = 'Purchased', inventory_id = L.inv_id,
       expense_id = (select e.id from expenses e where e.source_type = 'Material Release' and e.source_id = md5('rel|' || L.bom_id)::text::uuid::text)
from L where L.bom_id = b.id and L.mode = 'stock';

-- ════════════════════════════════════════════════════════════════════════════
-- 8. Excess returns on finished projects (stock +)
-- ════════════════════════════════════════════════════════════════════════════
insert into material_excess_returns (id, release_id, material_id, material_name, qty_returned, qty_remaining, po_number, date, notes)
select md5('exr|' || r.id)::uuid, r.id, r.material_id, r.material_name, 1, 1, r.po_number, least(r.date + 3, current_date),
       'Unused offcut returned to stock'
from (select distinct on (po) l.po, l.bom_id from L l where l.mode = 'bought' and l.qty >= 3 and l.po in ('PO-2026-0103','PO-2026-0104','PO-2026-0108')
      order by l.po, l.qty desc, l.pos) x
join material_releases r on r.id = md5('rel|' || x.bom_id)::uuid;

-- ════════════════════════════════════════════════════════════════════════════
-- 9. Supplier invoices (payables) and payments (expense + bank withdrawal)
-- ════════════════════════════════════════════════════════════════════════════
insert into purchase_order_invoices (id, purchase_order_id, invoice_number, amount, date, payment_method, expense_id, sales_invoice_number)
select md5('pinv|' || id)::uuid, id, upper(left(regexp_replace(supplier_name, '[^A-Za-z]', '', 'g'), 3)) || '-' || (40000 + (row_number() over (order by d))::int * 37),
       total, recv, null, null, null
from spo where mode = 'bought';

create temp table pay as
select s.id as spo, s.po, s.supplier_name, s.total, s.paid,
       'SI-' || (50100 + row_number() over (order by s.paid, s.id)::int * 13) as sales_inv,
       'EXP-10' || lpad((row_number() over (order by s.paid, s.id))::text, 2, '0') as exp_id,
       'TXN-PO-' || lpad((row_number() over (order by s.paid, s.id))::text, 3, '0') as txn_id,
       md5('payid|' || s.id)::uuid as pay_id,
       (select st.id from bank_statements st where s.paid between st.start_date and st.end_date limit 1) as stmt
from spo s where s.paid is not null;

insert into expenses (id, date, category, description, amount, payment_method, receipt, status, po_number, source_type, source_id)
select exp_id, paid, 'Materials/BOM', supplier_name || ' — PO ' || spo || ' (Sales Inv# ' || sales_inv || ')', total, 'Bank Transfer',
       sales_inv, 'Paid', po, 'PO Payment', pay_id::text
from pay;

insert into purchase_order_invoices (id, purchase_order_id, invoice_number, amount, date, payment_method, expense_id, sales_invoice_number)
select pay_id, spo, null, total, paid, 'Bank Transfer', exp_id, sales_inv from pay;

insert into bank_transactions (id, bank_statement_id, bank_account_id, date, particulars, bank_channel, amount, direction, category,
                               expense_id, po_number, source_type, source_id)
select txn_id, stmt, 'BANK-001', paid, supplier_name || ' — PO ' || spo || ' (Sales Inv# ' || sales_inv || ')', 'Online Transfer',
       total, 'Withdrawal', 'Supplier Payment', exp_id, po, 'PO Payment', pay_id::text
from pay;

-- ════════════════════════════════════════════════════════════════════════════
-- 10. Bank statements carry forward (opening + deposits - withdrawals = closing)
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare r record; open_bal numeric := 650000; close_bal numeric;
begin
  for r in select * from bank_statements order by start_date loop
    close_bal := open_bal
      + coalesce((select sum(amount) from bank_transactions where bank_statement_id = r.id and direction = 'Deposit'), 0)
      - coalesce((select sum(amount) from bank_transactions where bank_statement_id = r.id and direction <> 'Deposit'), 0);
    update bank_statements set beginning_balance = open_bal,
           passbook_ending_balance = case when status = 'Closed' then close_bal end where id = r.id;
    open_bal := close_bal;
  end loop;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 11. Timeline: client-invoice events via the same logger the triggers use, real dates
--     on supplier-PO / quote events, plus the manual milestones a person would log
-- ════════════════════════════════════════════════════════════════════════════
select tl_log(po_number, 'Invoiced', 'Invoice ' || id || coalesce(' — ' || client, ''), 'inv:' || id, date)
from invoices where po_number is not null;
select tl_log(po_number, 'Invoice Paid', 'Invoice ' || id || ' marked Paid', 'invpaid:' || id, collection_date)
from invoices where po_number is not null and status = 'Paid';

alter table project_timeline disable trigger trg_tl_protect_auto;
update project_timeline t set event_date = s.date_released
  from purchase_order_items poi join purchase_orders s on s.id = poi.purchase_order_id
 where t.ref_key = 'poi:' || poi.id;
update project_timeline t set event_date = sq.quoted_date
  from supplier_quotes sq where t.ref_key = 'sq:' || sq.id::text;
alter table project_timeline enable trigger trg_tl_protect_auto;

insert into project_timeline (po_number, event_type, event_date, notes, created_by_name, source) values
 ('PO-2026-0101','PO Received','2026-07-14','Client PO received; quotation QT-2026-001 approved','Demo Admin','manual'),
 ('PO-2026-0101','Fabrication Started','2026-08-18','Cutting and welding in progress','Demo Admin','manual'),
 ('PO-2026-0102','PO Received','2026-07-22','Client PO received; quotation QT-2026-002 approved','Demo Admin','manual'),
 ('PO-2026-0103','PO Received','2026-07-26','Client PO received; quotation QT-2026-003 approved','Demo Admin','manual'),
 ('PO-2026-0103','Fabrication Started','2026-08-12','Fabrication started','Demo Admin','manual'),
 ('PO-2026-0103','Fabrication Complete','2026-08-20','Fabrication and QC complete','Demo Admin','manual'),
 ('PO-2026-0103','Delivered','2026-08-23','Delivered to client — DR-1000','Demo Admin','manual'),
 ('PO-2026-0103','Payment Collected','2026-09-13','Payment received — CR-500','Demo Admin','manual'),
 ('PO-2026-0104','PO Received','2026-08-03','Client PO received; quotation QT-2026-004 approved','Demo Admin','manual'),
 ('PO-2026-0104','Fabrication Started','2026-08-17','Fabrication started','Demo Admin','manual'),
 ('PO-2026-0104','Fabrication Complete','2026-08-28','Fabrication and QC complete','Demo Admin','manual'),
 ('PO-2026-0104','Delivered','2026-08-31','Delivered to client — DR-1001','Demo Admin','manual'),
 ('PO-2026-0104','Payment Collected','2026-09-21','Payment received — CR-501','Demo Admin','manual'),
 ('PO-2026-0105','PO Received','2026-08-28','Client PO received; quotation QT-2026-008 approved','Demo Admin','manual'),
 ('PO-2026-0105','Fabrication Started','2026-09-22','Fabrication started','Demo Admin','manual'),
 ('PO-2026-0106','PO Received','2026-09-02','Client PO received; quotation QT-2026-009 approved','Demo Admin','manual'),
 ('PO-2026-0106','Fabrication Started','2026-09-16','Fabrication started','Demo Admin','manual'),
 ('PO-2026-0106','Fabrication Complete','2026-09-27','Fabrication and QC complete','Demo Admin','manual'),
 ('PO-2026-0106','Delivered','2026-09-30','Delivered to client — DR-1002','Demo Admin','manual'),
 ('PO-2026-0107','PO Received','2026-09-21','Client PO received; quotation QT-2026-012 approved','Demo Admin','manual'),
 ('PO-2026-0107','Quotation Added','2026-09-29','Added 1 quotation(s): QT-2026-015 (stairway and machine guard add-on)','Demo Admin','manual'),
 ('PO-2026-0107','Other','2026-10-05','On hold — awaiting client revised drawings','Demo Admin','manual'),
 ('PO-2026-0108','PO Received','2026-08-10','Client PO received; quotation QT-2026-013 approved','Demo Admin','manual'),
 ('PO-2026-0108','Fabrication Started','2026-08-25','Fabrication started','Demo Admin','manual'),
 ('PO-2026-0108','Fabrication Complete','2026-09-07','Fabrication and QC complete','Demo Admin','manual'),
 ('PO-2026-0108','Delivered','2026-09-10','Delivered to client — DR-1003','Demo Admin','manual'),
 ('PO-2026-0108','Quotation Added','2026-09-20','Added 1 quotation(s): QT-2026-005 (batch 2 — platform ladder and work table)','Demo Admin','manual');

-- ════════════════════════════════════════════════════════════════════════════
-- 12. Re-seal the audit trail
-- ════════════════════════════════════════════════════════════════════════════
select ledger_rebuild();

commit;
