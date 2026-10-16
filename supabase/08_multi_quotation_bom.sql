-- 08_multi_quotation_bom.sql
-- Metro (PO-2026-0108) and Greenfield (PO-2026-0107) now carry TWO quotations each,
-- with the BOM generated from the quotations' material lines (as the app does when
-- quotations are attached to a PO). Also zeroes the stray quotation discounts so
-- PO totals, invoices and deposits agree.

-- 0. Discounts: invoices carry no discount, so keep quotation == invoice -------------
update quotations set discount_pct = 0 where id in ('QT-2026-003','QT-2026-004','QT-2026-008');

-- 1. Reorder quotation lines so each item is followed directly by its materials ----
--    (the app assigns materials to the item above them; a note in between breaks it)
update quotation_items set position = 10 where quotation_id='QT-2026-013' and kind='note' and position=2;
update quotation_items set position = 11 where quotation_id='QT-2026-013' and kind='note' and position=7;
update quotation_items set position = 11 where quotation_id='QT-2026-005' and kind='note' and position=2;
update quotation_items set position = 12 where quotation_id='QT-2026-005' and kind='note' and position=7;
update quotation_items set position = 6  where quotation_id='QT-2026-012' and kind='note' and position=2;

-- 2. New Greenfield add-on quotation QT-2026-015 -------------------------------------
insert into quotations (id, client, date, valid_until, status, notes, tax, company_name, address, attention,
                        delivery_date, payment_terms, prepared_by, vat_mode, signatory_position, discount_pct,
                        po_number, version_number, root_quotation_id)
select 'QT-2026-015', client, date '2026-09-24', date '2026-10-24', 'Approved',
       'Add-on scope to the mezzanine storage rack order', tax, company_name, address, attention,
       delivery_date, payment_terms, prepared_by, 'excluded', signatory_position, 0,
       'PO-2026-0107', 1, 'QT-2026-015'
from quotations where id='QT-2026-012'
on conflict (id) do nothing;

delete from quotation_items where quotation_id='QT-2026-015';
insert into quotation_items (quotation_id, description, qty, unit, price, kind, position, line_uid) values
 ('QT-2026-015','FABRICATION OF',null,'',null,'scope',0,null),
 ('QT-2026-015','STAIRWAY WITH HANDRAIL',1,'LOT',68000,'item',1,gen_random_uuid()::text),
 ('QT-2026-015','STEEL ANGLE BAR 2"x2"',6,'LGTH',3105,'material',2,gen_random_uuid()::text),
 ('QT-2026-015','CHECKERED PLATE 3MM',4,'SHT',4174,'material',3,gen_random_uuid()::text),
 ('QT-2026-015','ANCHOR BOLT 1/2"',8,'PCS',1628,'material',4,gen_random_uuid()::text),
 ('QT-2026-015','MACHINE GUARD / SAFETY CAGE',2,'SET',18800,'item',5,gen_random_uuid()::text),
 ('QT-2026-015','SUS304 SQ. TUBE 1-1/2"',3,'LGTH',2098,'material',6,gen_random_uuid()::text),
 ('QT-2026-015','GI WIRE MESH',2,'SHT',1509,'material',7,gen_random_uuid()::text),
 ('QT-2026-015','Finish: red oxide primer and enamel topcoat on all mild steel.',null,'',null,'note',8,null);

-- 3. Attach quotations to their POs, assign Job Order numbers ------------------------
update quotations set status='Approved', po_number='PO-2026-0108' where id='QT-2026-005';
update quotations set job_order_number = case id
  when 'QT-2026-013' then '20260810001' when 'QT-2026-005' then '20260920001'
  when 'QT-2026-012' then '20260921001' when 'QT-2026-015' then '20260929001' end
 where id in ('QT-2026-013','QT-2026-005','QT-2026-012','QT-2026-015');

-- 4. Metro batch-1 materials bought on supplier credit (open payable) ----------------
insert into expenses (id, date, category, description, amount, payment_method, receipt, status, po_number, source_type, source_id)
values ('EXP-0930','2026-08-22','Materials/BOM','SUS304 sheet, tube, legs, wire mesh, angle bar — Metro batch 1',27654,'Bank Transfer','SI-30517','Unpaid','PO-2026-0108','Supplier Receipt','SI-30517')
on conflict (id) do nothing;

-- 5. Item quantities + BOM generated from the quotations -----------------------------
-- (existing hand-seeded BOM rows for these POs are re-used and re-pointed at their
--  quotation lines; extra generated rows are inserted — no deletes needed)
insert into project_item_quantities (po_number, quotation_id, item_line_uid, description, quoted_qty, po_qty)
select q.po_number, q.id, i.line_uid, i.description, i.qty, i.qty
from quotations q join quotation_items i on i.quotation_id=q.id and i.kind='item'
where q.po_number in ('PO-2026-0107','PO-2026-0108')
  and not exists (select 1 from project_item_quantities x where x.po_number=q.po_number and x.item_line_uid=i.line_uid);

with gen as (
  select q.po_number po, q.id qid, m.line_uid uid, m.description descr, coalesce(m.dimension,'') dim, m.qty qty, m.unit unit, m.price price,
         case when q.id='QT-2026-013' then 'Purchased' else 'Not Purchased' end st,
         case when q.id='QT-2026-013' then m.qty else 0 end qp,
         case when q.id='QT-2026-013' then 'EXP-0930' end exp,
         row_number() over (partition by q.po_number order by q.id, m.position) rn
  from quotations q join quotation_items m on m.quotation_id=q.id and m.kind='material'
  where q.po_number in ('PO-2026-0107','PO-2026-0108')
    and exists (select 1 from quotation_items i3 where i3.quotation_id=q.id and i3.kind='item' and i3.position < m.position)
), old as (
  select id, po_number, row_number() over (partition by po_number order by created_at, id) rn
  from project_bom where po_number in ('PO-2026-0107','PO-2026-0108') and source_quotation_id is null
), upd as (
  update project_bom b set source_quotation_id=gen.qid, source_line_uid=gen.uid, description=gen.descr, dimension=gen.dim,
         qty_needed=gen.qty, unit=gen.unit, estimated_unit_cost=gen.price, status=gen.st, qty_purchased=gen.qp, expense_id=gen.exp, status_note=null
  from old join gen on gen.po=old.po_number and gen.rn=old.rn
  where b.id=old.id returning gen.po, gen.rn
)
insert into project_bom (po_number, source_quotation_id, source_line_uid, description, dimension, qty_needed, unit, estimated_unit_cost, status, qty_purchased, expense_id)
select po, qid, uid, descr, dim, qty, unit, price, st, qp, exp from gen
where not exists (select 1 from upd where upd.po=gen.po and upd.rn=gen.rn);

-- 6. Project totals + timeline --------------------------------------------------------
-- PO-0108: 217,952 (QT-013) + 88,144 (QT-005) ; PO-0107: 217,504 (QT-012) + 118,272 (QT-015)
update projects set po_total_value=306096, value=306096, end_date='2026-10-31', delivery_date_needed='2026-10-31' where id='PRJ-008';
update projects set po_total_value=335776, value=335776 where id='PRJ-007';

insert into project_timeline (po_number, event_type, event_date, notes, created_by_name, source) values
 ('PO-2026-0108','Quotation Added','2026-09-20','Added 1 quotation(s): QT-2026-005 (batch 2 — platform ladder and work table)','Demo Admin','manual'),
 ('PO-2026-0108','Material Requested','2026-09-22','Batch 2 materials released to purchasing','Demo Admin','manual'),
 ('PO-2026-0107','Quotation Added','2026-09-29','Added 1 quotation(s): QT-2026-015 (stairway and machine guard add-on)','Demo Admin','manual');

-- 7. Re-seal the audit trail -------------------------------------------------------------
select ledger_rebuild();
