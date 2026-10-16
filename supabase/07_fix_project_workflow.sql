-- 07_fix_project_workflow.sql
-- Makes the demo's Projects follow the same rules as the real system:
--   * "Completed" only when every invoice is paid (CR # + date collected)
--   * DR #, delivery date, CR #, collection fields and timeline filled in
--   * Tax-inclusive quotations carry their FULL amount (no stray 5% discount)
--   * Bank deposits = invoice totals, so income reaches the Accounting Ledger
-- Safe to re-run.

-- 1. Projects ---------------------------------------------------------------
update projects set status='Active', progress=65, end_date='2026-10-30', delivery_date_needed='2026-10-30',
  dr_number=null, cr_number=null, actual_delivery_date=null, collection_date=null, date_collected=null,
  collection_amount=0, payment_status='N/A' where id='PRJ-001';

update projects set status='Active', progress=50, end_date='2026-11-15', delivery_date_needed='2026-11-15',
  dr_number=null, cr_number=null, actual_delivery_date=null, collection_date=null, date_collected=null,
  collection_amount=0, payment_status='N/A' where id='PRJ-002';

update projects set status='Completed', progress=100, end_date='2026-08-20', delivery_date_needed='2026-08-25',
  po_total_value=85600, value=85600, dr_number='DR-1000', cr_number='CR-500',
  actual_delivery_date='2026-08-23', collection_date='2026-09-13', date_collected='2026-09-13',
  collection_amount=85600, payment_status='Paid' where id='PRJ-003';

update projects set status='Completed', progress=100, end_date='2026-08-28', delivery_date_needed='2026-09-02',
  po_total_value=90300, value=90300, dr_number='DR-1001', cr_number='CR-501',
  actual_delivery_date='2026-08-31', collection_date='2026-09-21', date_collected='2026-09-21',
  collection_amount=90300, payment_status='Paid' where id='PRJ-004';

update projects set status='Active', progress=65, end_date='2026-10-31', delivery_date_needed='2026-10-31',
  po_total_value=308000, value=308000,
  dr_number=null, cr_number=null, actual_delivery_date=null, collection_date=null, date_collected=null,
  collection_amount=0, payment_status='N/A' where id='PRJ-005';

update projects set status='Active', progress=85, end_date='2026-09-27', delivery_date_needed='2026-10-02',
  dr_number='DR-1002', cr_number=null, actual_delivery_date='2026-09-30', collection_date='2026-10-30',
  date_collected=null, collection_amount=0, payment_status='Pending' where id='PRJ-006';

update projects set status='On Hold', progress=40, end_date='2026-11-20', delivery_date_needed='2026-11-20',
  dr_number=null, cr_number=null, actual_delivery_date=null, collection_date=null, date_collected=null,
  collection_amount=0, payment_status='N/A' where id='PRJ-007';

update projects set status='Active', progress=85, start_date='2026-08-10', end_date='2026-09-07', delivery_date_needed='2026-09-12',
  dr_number='DR-1003', cr_number=null, actual_delivery_date='2026-09-10', collection_date='2026-10-10',
  date_collected=null, collection_amount=0, payment_status='Overdue' where id='PRJ-008';

-- 2. Invoices: delivery dates + full collected amounts --------------------------
update invoices set delivery_date='2026-08-23', collection_amount=85600 where id='INV-2026-001';
update invoices set delivery_date='2026-08-31', collection_amount=90300 where id='INV-2026-002';
update invoices set delivery_date='2026-09-30' where id='INV-2026-003';
update invoices set delivery_date='2026-09-10' where id='INV-2026-004';

-- 3. Bank deposits = invoice totals ------------------------------------------
update bank_transactions set amount=85600 where invoice_id='INV-2026-001' and direction='Deposit';
update bank_transactions set amount=90300 where invoice_id='INV-2026-002' and direction='Deposit';
update bank_statements set passbook_ending_balance=364785.38+8795 where id='STMT-2026-09';
update bank_statements set beginning_balance=364785.38+8795 where id='STMT-2026-10';

-- 4. Timeline ----------------------------------------------------------------
delete from project_timeline where po_number in ('PO-2026-0101','PO-2026-0102','PO-2026-0103','PO-2026-0104','PO-2026-0105','PO-2026-0106','PO-2026-0107','PO-2026-0108');
insert into project_timeline (po_number, event_type, event_date, notes, created_by_name, source) values
 ('PO-2026-0101','PO Received','2026-07-14','Client PO received; quotation QT-2026-001 approved','Demo Admin','manual'),
 ('PO-2026-0101','Material Requested','2026-07-30','Bill of materials released to purchasing','Demo Admin','manual'),
 ('PO-2026-0101','Supplier PO Issued','2026-08-03','Steel and consumables ordered','Demo Admin','manual'),
 ('PO-2026-0101','Material Purchased','2026-08-11','Main materials received','Demo Admin','manual'),
 ('PO-2026-0101','Fabrication Started','2026-08-18','Cutting and welding in progress','Demo Admin','manual'),
 ('PO-2026-0102','PO Received','2026-07-22','Client PO received; quotation QT-2026-002 approved','Demo Admin','manual'),
 ('PO-2026-0102','Material Requested','2026-08-05','Bill of materials released to purchasing','Demo Admin','manual'),
 ('PO-2026-0102','Supplier PO Issued','2026-08-12','Supplier PO issued for sheet metal','Demo Admin','manual'),
 ('PO-2026-0103','PO Received','2026-07-26','Client PO received; quotation QT-2026-003 approved','Demo Admin','manual'),
 ('PO-2026-0103','Material Requested','2026-08-01','Bill of materials released to purchasing','Demo Admin','manual'),
 ('PO-2026-0103','Supplier PO Issued','2026-08-04','Supplier PO issued','Demo Admin','manual'),
 ('PO-2026-0103','Material Purchased','2026-08-10','Materials received','Demo Admin','manual'),
 ('PO-2026-0103','Fabrication Started','2026-08-12','Fabrication started','Demo Admin','manual'),
 ('PO-2026-0103','Fabrication Complete','2026-08-20','Fabrication and QC complete','Demo Admin','manual'),
 ('PO-2026-0103','Delivered','2026-08-23','Delivered to client — DR-1000','Demo Admin','manual'),
 ('PO-2026-0103','Invoiced','2026-08-23','INV-2026-001 issued','Demo Admin','manual'),
 ('PO-2026-0103','Payment Collected','2026-09-13','Payment received — CR-500','Demo Admin','manual'),
 ('PO-2026-0104','PO Received','2026-08-03','Client PO received; quotation QT-2026-004 approved','Demo Admin','manual'),
 ('PO-2026-0104','Material Requested','2026-08-06','Bill of materials released to purchasing','Demo Admin','manual'),
 ('PO-2026-0104','Supplier PO Issued','2026-08-10','Supplier PO issued','Demo Admin','manual'),
 ('PO-2026-0104','Material Purchased','2026-08-14','Materials received','Demo Admin','manual'),
 ('PO-2026-0104','Fabrication Started','2026-08-17','Fabrication started','Demo Admin','manual'),
 ('PO-2026-0104','Fabrication Complete','2026-08-28','Fabrication and QC complete','Demo Admin','manual'),
 ('PO-2026-0104','Delivered','2026-08-31','Delivered to client — DR-1001','Demo Admin','manual'),
 ('PO-2026-0104','Invoiced','2026-08-31','INV-2026-002 issued','Demo Admin','manual'),
 ('PO-2026-0104','Payment Collected','2026-09-21','Payment received — CR-501','Demo Admin','manual'),
 ('PO-2026-0105','PO Received','2026-08-28','Client PO received; quotation QT-2026-008 approved','Demo Admin','manual'),
 ('PO-2026-0105','Material Requested','2026-09-02','Bill of materials released to purchasing','Demo Admin','manual'),
 ('PO-2026-0105','Supplier PO Issued','2026-09-08','Supplier PO issued','Demo Admin','manual'),
 ('PO-2026-0105','Material Purchased','2026-09-15','Materials received','Demo Admin','manual'),
 ('PO-2026-0105','Fabrication Started','2026-09-22','Fabrication started','Demo Admin','manual'),
 ('PO-2026-0106','PO Received','2026-09-02','Client PO received; quotation QT-2026-009 approved','Demo Admin','manual'),
 ('PO-2026-0106','Material Requested','2026-09-05','Bill of materials released to purchasing','Demo Admin','manual'),
 ('PO-2026-0106','Supplier PO Issued','2026-09-09','Supplier PO issued','Demo Admin','manual'),
 ('PO-2026-0106','Material Purchased','2026-09-14','Materials received','Demo Admin','manual'),
 ('PO-2026-0106','Fabrication Started','2026-09-16','Fabrication started','Demo Admin','manual'),
 ('PO-2026-0106','Fabrication Complete','2026-09-27','Fabrication and QC complete','Demo Admin','manual'),
 ('PO-2026-0106','Delivered','2026-09-30','Delivered to client — DR-1002','Demo Admin','manual'),
 ('PO-2026-0106','Invoiced','2026-09-30','INV-2026-003 issued; payment due 2026-10-30','Demo Admin','manual'),
 ('PO-2026-0107','PO Received','2026-09-21','Client PO received; quotation QT-2026-012 approved','Demo Admin','manual'),
 ('PO-2026-0107','Material Requested','2026-09-25','Bill of materials released to purchasing','Demo Admin','manual'),
 ('PO-2026-0107','Other','2026-10-05','On hold — awaiting client revised drawings','Demo Admin','manual'),
 ('PO-2026-0108','PO Received','2026-08-10','Client PO received; quotation QT-2026-013 approved','Demo Admin','manual'),
 ('PO-2026-0108','Material Requested','2026-08-13','Bill of materials released to purchasing','Demo Admin','manual'),
 ('PO-2026-0108','Supplier PO Issued','2026-08-17','Supplier PO issued','Demo Admin','manual'),
 ('PO-2026-0108','Material Purchased','2026-08-22','Materials received','Demo Admin','manual'),
 ('PO-2026-0108','Fabrication Started','2026-08-25','Fabrication started','Demo Admin','manual'),
 ('PO-2026-0108','Fabrication Complete','2026-09-07','Fabrication and QC complete','Demo Admin','manual'),
 ('PO-2026-0108','Delivered','2026-09-10','Delivered to client — DR-1003','Demo Admin','manual'),
 ('PO-2026-0108','Invoiced','2026-09-10','INV-2026-004 issued; payment was due 2026-10-10','Demo Admin','manual');

-- 5. Re-seal the audit trail so it matches the corrected data -----------------
select ledger_rebuild();
