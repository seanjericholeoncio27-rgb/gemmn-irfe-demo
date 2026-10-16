-- =====================================================================
-- 06_relink_accounting.sql — DEMO DATA: rebuild the accounting layer so every
-- peso traces back to an operational record. Run AFTER 01, 02, 04 and 05.
-- Keeps projects, quotations, invoices, POs, receipts, releases, payroll and
-- petty cash vouchers; replaces expenses, bank transactions and PO
-- supplier invoices/payments; then re-seals the hash chain.
-- =====================================================================
begin;

-- clear the old, loosely connected accounting layer
update petty_cash_periods set replenishment_bank_transaction_id = null;
delete from outstanding_checks;
delete from bank_transactions;
update project_bom set expense_id = null;
delete from purchase_order_invoices;
delete from expenses where id not in (select expense_id from petty_cash_voucher_lines where expense_id is not null);

-- petty cash expenses keep their vouchers as the source document
update expenses e set source_type='Petty Cash Voucher', source_id=v.id, receipt=v.pcv_number, po_number=null, status='Paid', payment_method='Petty Cash'
  from petty_cash_voucher_lines l join petty_cash_vouchers v on v.id=l.voucher_id where l.expense_id=e.id;

-- keep invoice dates consistent with the status shown
update invoices set date='2026-09-10', due_date='2026-10-10' where id='INV-2026-004';


-- SPO-2026-007: supplier invoice + payment
insert into purchase_order_invoices (id,purchase_order_id,invoice_number,amount,date,payment_method,expense_id,sales_invoice_number)
select 'c06b1459-8682-5f31-8bda-8c1c8952bb5a',o.id,'GCI-20871',(select sum(qty*unit_price) from purchase_order_items i where i.purchase_order_id=o.id),'2026-07-30',null,null,null from purchase_orders o where o.id='SPO-2026-007';
insert into expenses (id,date,category,description,amount,payment_method,receipt,status,po_number,source_type,source_id)
select 'EXP-0901','2026-08-03','Materials/BOM',s.name||' — PO SPO-2026-007 (Sales Inv# GCI-20871)',(select sum(qty*unit_price) from purchase_order_items i where i.purchase_order_id=o.id),'Bank Transfer','GCI-20871','Paid','PO-2026-0101','PO Payment','1019b51e-a4a6-5186-bf6d-6a1d65658f76'
from purchase_orders o join suppliers s on s.id=o.supplier_id where o.id='SPO-2026-007';
insert into purchase_order_invoices (id,purchase_order_id,invoice_number,amount,date,payment_method,expense_id,sales_invoice_number)
select '1019b51e-a4a6-5186-bf6d-6a1d65658f76',o.id,null,(select amount from expenses where id='EXP-0901'),'2026-08-03','Bank Transfer','EXP-0901','GCI-20871' from purchase_orders o where o.id='SPO-2026-007';
update purchase_orders set amount_invoiced=(select amount from expenses where id='EXP-0901'), amount_paid=(select amount from expenses where id='EXP-0901'), status='Paid', payment_terms='30 Days' where id='SPO-2026-007';

-- SPO-2026-001: supplier invoice + payment
insert into purchase_order_invoices (id,purchase_order_id,invoice_number,amount,date,payment_method,expense_id,sales_invoice_number)
select 'f22be4f9-ce65-5738-a90b-287450516dd8',o.id,'PMS-44102',(select sum(qty*unit_price) from purchase_order_items i where i.purchase_order_id=o.id),'2026-08-06',null,null,null from purchase_orders o where o.id='SPO-2026-001';
insert into expenses (id,date,category,description,amount,payment_method,receipt,status,po_number,source_type,source_id)
select 'EXP-0902','2026-08-11','Materials/BOM',s.name||' — PO SPO-2026-001 (Sales Inv# PMS-44102)',(select sum(qty*unit_price) from purchase_order_items i where i.purchase_order_id=o.id),'Bank Transfer','PMS-44102','Paid','PO-2026-0101','PO Payment','22a17d08-c1e4-5d16-9598-68607cfda839'
from purchase_orders o join suppliers s on s.id=o.supplier_id where o.id='SPO-2026-001';
insert into purchase_order_invoices (id,purchase_order_id,invoice_number,amount,date,payment_method,expense_id,sales_invoice_number)
select '22a17d08-c1e4-5d16-9598-68607cfda839',o.id,null,(select amount from expenses where id='EXP-0902'),'2026-08-11','Bank Transfer','EXP-0902','PMS-44102' from purchase_orders o where o.id='SPO-2026-001';
update purchase_orders set amount_invoiced=(select amount from expenses where id='EXP-0902'), amount_paid=(select amount from expenses where id='EXP-0902'), status='Paid', payment_terms='15 Days' where id='SPO-2026-001';

-- SPO-2026-004: supplier invoice + payment
insert into purchase_order_invoices (id,purchase_order_id,invoice_number,amount,date,payment_method,expense_id,sales_invoice_number)
select 'f1f2573c-ccf5-57c7-a4c7-7bda956e01a8',o.id,'IWT-9087',(select sum(qty*unit_price) from purchase_order_items i where i.purchase_order_id=o.id),'2026-08-12',null,null,null from purchase_orders o where o.id='SPO-2026-004';
insert into expenses (id,date,category,description,amount,payment_method,receipt,status,po_number,source_type,source_id)
select 'EXP-0903','2026-08-17','Materials/BOM',s.name||' — PO SPO-2026-004 (Sales Inv# IWT-9087)',(select sum(qty*unit_price) from purchase_order_items i where i.purchase_order_id=o.id),'Bank Transfer','IWT-9087','Paid','PO-2026-0101','PO Payment','bca1fc5e-53fa-5853-beba-875446a07d0e'
from purchase_orders o join suppliers s on s.id=o.supplier_id where o.id='SPO-2026-004';
insert into purchase_order_invoices (id,purchase_order_id,invoice_number,amount,date,payment_method,expense_id,sales_invoice_number)
select 'bca1fc5e-53fa-5853-beba-875446a07d0e',o.id,null,(select amount from expenses where id='EXP-0903'),'2026-08-17','Bank Transfer','EXP-0903','IWT-9087' from purchase_orders o where o.id='SPO-2026-004';
update purchase_orders set amount_invoiced=(select amount from expenses where id='EXP-0903'), amount_paid=(select amount from expenses where id='EXP-0903'), status='Paid', payment_terms='Cash On Delivery' where id='SPO-2026-004';

-- SPO-2026-002: supplier invoice (unpaid, still payable)
insert into purchase_order_invoices (id,purchase_order_id,invoice_number,amount,date,payment_method,expense_id,sales_invoice_number)
select 'c6863e38-1f2b-5677-99b7-cc02451657e0',o.id,'PMS-44790',(select sum(qty_received*unit_price) from purchase_order_items i where i.purchase_order_id=o.id),'2026-09-12',null,null,null from purchase_orders o where o.id='SPO-2026-002';
update purchase_orders set amount_invoiced=(select amount from purchase_order_invoices where id='c6863e38-1f2b-5677-99b7-cc02451657e0'), amount_paid=0, status='Partially Invoiced', payment_terms='30 Days' where id='SPO-2026-002';

-- payroll run → expense → bank withdrawal
insert into expenses (id,date,category,description,amount,payment_method,receipt,status,po_number,source_type,source_id)
select 'EXP-0904','2026-09-26','Payroll','Payroll Sep 11–25, 2026 (12 employees)',
 (select sum(coalesce(regular_pay,0)+coalesce(overtime_pay,0)+coalesce(sunday_pay,0)+coalesce(night_diff_pay,0)+coalesce(leave_pay,0)+coalesce(regular_holiday_pay,0)+coalesce(special_holiday_pay,0)+coalesce(allowance,0)+coalesce(bday_amount,0)
   -coalesce(sss,0)-coalesce(philhealth,0)-coalesce(pagibig,0)-coalesce(tax,0)-coalesce(cash_advance_deduction,0)-coalesce(company_deduction,0)-coalesce(loan_deduction,0)-coalesce(other_deductions,0)) from payroll where payroll_run_id=r.id),
 'Bank Transfer','PAYSLIPS-2026-09B','Paid',null,'Payroll',r.id::text from payroll_runs r limit 1;

-- direct purchases (tied to a project) and overhead, each with its source document
insert into expenses (id,date,category,description,amount,payment_method,receipt,status,po_number,source_type,source_id) values ('EXP-0905','2026-08-03','Materials/BOM','Welding rods & consumables',31510,'Bank Transfer','SI-30881','Paid','PO-2026-0101','Supplier Receipt','SI-30881');
insert into expenses (id,date,category,description,amount,payment_method,receipt,status,po_number,source_type,source_id) values ('EXP-0906','2026-09-04','Materials/BOM','SUS304 sheets — supplier',37570,'Bank Transfer','SI-31440','Paid','PO-2026-0103','Supplier Receipt','SI-31440');
insert into expenses (id,date,category,description,amount,payment_method,receipt,status,po_number,source_type,source_id) values ('EXP-0907','2026-09-11','Materials/BOM','Steel angle bars',4820,'Check','SI-31502','Paid','PO-2026-0104','Supplier Receipt','SI-31502');
insert into expenses (id,date,category,description,amount,payment_method,receipt,status,po_number,source_type,source_id) values ('EXP-0908','2026-09-21','Materials/BOM','SUS304 sheets — supplier',33960,'Bank Transfer','SI-31655','Paid','PO-2026-0104','Supplier Receipt','SI-31655');
insert into expenses (id,date,category,description,amount,payment_method,receipt,status,po_number,source_type,source_id) values ('EXP-0909','2026-08-05','Rent','Warehouse monthly rent',35000,'Check','LEASE-2026-08','Paid',null,'Billing Statement','LEASE-2026-08');
insert into expenses (id,date,category,description,amount,payment_method,receipt,status,po_number,source_type,source_id) values ('EXP-0910','2026-09-05','Rent','Warehouse monthly rent',35000,'Check','LEASE-2026-09','Paid',null,'Billing Statement','LEASE-2026-09');
insert into expenses (id,date,category,description,amount,payment_method,receipt,status,po_number,source_type,source_id) values ('EXP-0911','2026-10-05','Rent','Warehouse monthly rent',35000,'Check','LEASE-2026-10','Paid',null,'Billing Statement','LEASE-2026-10');
insert into expenses (id,date,category,description,amount,payment_method,receipt,status,po_number,source_type,source_id) values ('EXP-0912','2026-08-09','Utilities','Electricity bill',9180,'Bank Transfer','ELEC-2026-08','Paid',null,'Billing Statement','ELEC-2026-08');
insert into expenses (id,date,category,description,amount,payment_method,receipt,status,po_number,source_type,source_id) values ('EXP-0913','2026-09-09','Utilities','Electricity bill',13100,'Bank Transfer','ELEC-2026-09','Paid',null,'Billing Statement','ELEC-2026-09');
insert into expenses (id,date,category,description,amount,payment_method,receipt,status,po_number,source_type,source_id) values ('EXP-0914','2026-10-07','Utilities','Water bill',12030,'Bank Transfer','WATER-2026-10','Unpaid',null,'Billing Statement','WATER-2026-10');
insert into expenses (id,date,category,description,amount,payment_method,receipt,status,po_number,source_type,source_id) values ('EXP-0915','2026-08-09','Internet','Fiber internet plan',1900,'Bank Transfer','ISP-2026-08','Paid',null,'Billing Statement','ISP-2026-08');
insert into expenses (id,date,category,description,amount,payment_method,receipt,status,po_number,source_type,source_id) values ('EXP-0916','2026-09-09','Internet','Fiber internet plan',1900,'Bank Transfer','ISP-2026-09','Paid',null,'Billing Statement','ISP-2026-09');
insert into expenses (id,date,category,description,amount,payment_method,receipt,status,po_number,source_type,source_id) values ('EXP-0917','2026-10-09','Internet','Fiber internet plan',1900,'Bank Transfer','ISP-2026-10','Paid',null,'Billing Statement','ISP-2026-10');
insert into expenses (id,date,category,description,amount,payment_method,receipt,status,po_number,source_type,source_id) values ('EXP-0918','2026-08-11','Equipment','New cutting tools',24570,'Check','OR-70213','Paid',null,'Supplier Receipt','OR-70213');
insert into expenses (id,date,category,description,amount,payment_method,receipt,status,po_number,source_type,source_id) values ('EXP-0919','2026-09-13','Equipment','New cutting tools',28330,'Check','OR-70388','Paid',null,'Supplier Receipt','OR-70388');
insert into expenses (id,date,category,description,amount,payment_method,receipt,status,po_number,source_type,source_id) values ('EXP-0920','2026-10-05','Equipment','New cutting tools',20650,'Check','OR-70512','Paid',null,'Supplier Receipt','OR-70512');
insert into expenses (id,date,category,description,amount,payment_method,receipt,status,po_number,source_type,source_id) values ('EXP-0921','2026-08-25','Office','Printer ink & paper',1970,'Bank Transfer','OR-11902','Paid',null,'Supplier Receipt','OR-11902');
insert into expenses (id,date,category,description,amount,payment_method,receipt,status,po_number,source_type,source_id) values ('EXP-0922','2026-09-09','Office','Printer ink & paper',2380,'Bank Transfer','OR-12044','Paid',null,'Supplier Receipt','OR-12044');
insert into expenses (id,date,category,description,amount,payment_method,receipt,status,po_number,source_type,source_id) values ('EXP-0923','2026-10-12','Office','Printer ink & paper',1760,'Bank Transfer','OR-12190','Paid',null,'Supplier Receipt','OR-12190');
insert into expenses (id,date,category,description,amount,payment_method,receipt,status,po_number,source_type,source_id) values ('EXP-0924','2026-08-03','Transportation','Toll & parking',5220,'Bank Transfer','TOLL-0803','Paid',null,'Supplier Receipt','TOLL-0803');
insert into expenses (id,date,category,description,amount,payment_method,receipt,status,po_number,source_type,source_id) values ('EXP-0925','2026-08-16','Transportation','Delivery truck fuel',3300,'Bank Transfer','FUEL-0816','Paid',null,'Supplier Receipt','FUEL-0816');
insert into expenses (id,date,category,description,amount,payment_method,receipt,status,po_number,source_type,source_id) values ('EXP-0926','2026-09-04','Transportation','Delivery truck fuel',4260,'Bank Transfer','FUEL-0904','Paid',null,'Supplier Receipt','FUEL-0904');
insert into expenses (id,date,category,description,amount,payment_method,receipt,status,po_number,source_type,source_id) values ('EXP-0927','2026-09-18','Transportation','Toll & parking',4100,'Bank Transfer','TOLL-0918','Paid',null,'Supplier Receipt','TOLL-0918');
insert into expenses (id,date,category,description,amount,payment_method,receipt,status,po_number,source_type,source_id) values ('EXP-0928','2026-10-03','Transportation','Toll & parking',4330,'Bank Transfer','TOLL-1003','Paid',null,'Supplier Receipt','TOLL-1003');
insert into expenses (id,date,category,description,amount,payment_method,receipt,status,po_number,source_type,source_id) values ('EXP-0929','2026-10-03','Transportation','Delivery truck fuel',4570,'Bank Transfer','FUEL-1003','Paid',null,'Supplier Receipt','FUEL-1003');

-- bank ledger: every line is linked to its expense, invoice or source document
insert into bank_transactions (id,bank_statement_id,bank_account_id,date,particulars,bank_channel,check_number,amount,direction,category,invoice_id,expense_id,po_number,source_type,source_id)
select 'TXN-2026-001','STMT-2026-08',(select id from bank_accounts limit 1),'2026-08-03','SPO-2026-007 supplier payment (GCI-20871)','Bank Transfer',null,(select amount from expenses where id='EXP-0901'),'Withdrawal','Supplier Payment',null,'EXP-0901','PO-2026-0101','PO Payment','1019b51e-a4a6-5186-bf6d-6a1d65658f76';
insert into bank_transactions (id,bank_statement_id,bank_account_id,date,particulars,bank_channel,check_number,amount,direction,category,invoice_id,expense_id,po_number,source_type,source_id)
select 'TXN-2026-002','STMT-2026-08',(select id from bank_accounts limit 1),'2026-08-03','Welding rods & consumables','Bank Transfer',null,31510,'Withdrawal','Materials',null,'EXP-0905','PO-2026-0101','Supplier Receipt','SI-30881';
insert into bank_transactions (id,bank_statement_id,bank_account_id,date,particulars,bank_channel,check_number,amount,direction,category,invoice_id,expense_id,po_number,source_type,source_id)
select 'TXN-2026-003','STMT-2026-08',(select id from bank_accounts limit 1),'2026-08-03','Toll & parking','Bank Transfer',null,5220,'Withdrawal','Other',null,'EXP-0924',null,'Supplier Receipt','TOLL-0803';
insert into bank_transactions (id,bank_statement_id,bank_account_id,date,particulars,bank_channel,check_number,amount,direction,category,invoice_id,expense_id,po_number,source_type,source_id)
select 'TXN-2026-004','STMT-2026-08',(select id from bank_accounts limit 1),'2026-08-05','Warehouse monthly rent','Check','LEASE-2026-08',35000,'Withdrawal','Other',null,'EXP-0909',null,'Billing Statement','LEASE-2026-08';
insert into bank_transactions (id,bank_statement_id,bank_account_id,date,particulars,bank_channel,check_number,amount,direction,category,invoice_id,expense_id,po_number,source_type,source_id)
select 'TXN-2026-005','STMT-2026-08',(select id from bank_accounts limit 1),'2026-08-09','Electricity bill','Bank Transfer',null,9180,'Withdrawal','Other',null,'EXP-0912',null,'Billing Statement','ELEC-2026-08';
insert into bank_transactions (id,bank_statement_id,bank_account_id,date,particulars,bank_channel,check_number,amount,direction,category,invoice_id,expense_id,po_number,source_type,source_id)
select 'TXN-2026-006','STMT-2026-08',(select id from bank_accounts limit 1),'2026-08-09','Fiber internet plan','Bank Transfer',null,1900,'Withdrawal','Other',null,'EXP-0915',null,'Billing Statement','ISP-2026-08';
insert into bank_transactions (id,bank_statement_id,bank_account_id,date,particulars,bank_channel,check_number,amount,direction,category,invoice_id,expense_id,po_number,source_type,source_id)
select 'TXN-2026-007','STMT-2026-08',(select id from bank_accounts limit 1),'2026-08-11','SPO-2026-001 supplier payment (PMS-44102)','Bank Transfer',null,(select amount from expenses where id='EXP-0902'),'Withdrawal','Supplier Payment',null,'EXP-0902','PO-2026-0101','PO Payment','22a17d08-c1e4-5d16-9598-68607cfda839';
insert into bank_transactions (id,bank_statement_id,bank_account_id,date,particulars,bank_channel,check_number,amount,direction,category,invoice_id,expense_id,po_number,source_type,source_id)
select 'TXN-2026-008','STMT-2026-08',(select id from bank_accounts limit 1),'2026-08-11','New cutting tools','Check','OR-70213',24570,'Withdrawal','Other',null,'EXP-0918',null,'Supplier Receipt','OR-70213';
insert into bank_transactions (id,bank_statement_id,bank_account_id,date,particulars,bank_channel,check_number,amount,direction,category,invoice_id,expense_id,po_number,source_type,source_id)
select 'TXN-2026-009','STMT-2026-08',(select id from bank_accounts limit 1),'2026-08-16','Delivery truck fuel','Bank Transfer',null,3300,'Withdrawal','Other',null,'EXP-0925',null,'Supplier Receipt','FUEL-0816';
insert into bank_transactions (id,bank_statement_id,bank_account_id,date,particulars,bank_channel,check_number,amount,direction,category,invoice_id,expense_id,po_number,source_type,source_id)
select 'TXN-2026-010','STMT-2026-08',(select id from bank_accounts limit 1),'2026-08-17','SPO-2026-004 supplier payment (IWT-9087)','Bank Transfer',null,(select amount from expenses where id='EXP-0903'),'Withdrawal','Supplier Payment',null,'EXP-0903','PO-2026-0101','PO Payment','bca1fc5e-53fa-5853-beba-875446a07d0e';
insert into bank_transactions (id,bank_statement_id,bank_account_id,date,particulars,bank_channel,check_number,amount,direction,category,invoice_id,expense_id,po_number,source_type,source_id)
select 'TXN-2026-011','STMT-2026-08',(select id from bank_accounts limit 1),'2026-08-25','Printer ink & paper','Bank Transfer',null,1970,'Withdrawal','Other',null,'EXP-0921',null,'Supplier Receipt','OR-11902';
insert into bank_transactions (id,bank_statement_id,bank_account_id,date,particulars,bank_channel,amount,direction,category,invoice_id,expense_id,po_number,source_type,source_id)
select 'TXN-2026-012','STMT-2026-08',(select id from bank_accounts limit 1),'2026-08-31','Interest credit','Bank Credit',412.38,'Deposit','Other',null,null,null,'Bank Memo','CM-0831';
insert into bank_transactions (id,bank_statement_id,bank_account_id,date,particulars,bank_channel,check_number,amount,direction,category,invoice_id,expense_id,po_number,source_type,source_id)
select 'TXN-2026-013','STMT-2026-09',(select id from bank_accounts limit 1),'2026-09-04','SUS304 sheets — supplier','Bank Transfer',null,37570,'Withdrawal','Materials',null,'EXP-0906','PO-2026-0103','Supplier Receipt','SI-31440';
insert into bank_transactions (id,bank_statement_id,bank_account_id,date,particulars,bank_channel,check_number,amount,direction,category,invoice_id,expense_id,po_number,source_type,source_id)
select 'TXN-2026-014','STMT-2026-09',(select id from bank_accounts limit 1),'2026-09-04','Delivery truck fuel','Bank Transfer',null,4260,'Withdrawal','Other',null,'EXP-0926',null,'Supplier Receipt','FUEL-0904';
insert into bank_transactions (id,bank_statement_id,bank_account_id,date,particulars,bank_channel,check_number,amount,direction,category,invoice_id,expense_id,po_number,source_type,source_id)
select 'TXN-2026-015','STMT-2026-09',(select id from bank_accounts limit 1),'2026-09-05','Warehouse monthly rent','Check','LEASE-2026-09',35000,'Withdrawal','Other',null,'EXP-0910',null,'Billing Statement','LEASE-2026-09';
insert into bank_transactions (id,bank_statement_id,bank_account_id,date,particulars,bank_channel,check_number,amount,direction,category,invoice_id,expense_id,po_number,source_type,source_id)
select 'TXN-2026-016','STMT-2026-09',(select id from bank_accounts limit 1),'2026-09-09','Electricity bill','Bank Transfer',null,13100,'Withdrawal','Other',null,'EXP-0913',null,'Billing Statement','ELEC-2026-09';
insert into bank_transactions (id,bank_statement_id,bank_account_id,date,particulars,bank_channel,check_number,amount,direction,category,invoice_id,expense_id,po_number,source_type,source_id)
select 'TXN-2026-017','STMT-2026-09',(select id from bank_accounts limit 1),'2026-09-09','Fiber internet plan','Bank Transfer',null,1900,'Withdrawal','Other',null,'EXP-0916',null,'Billing Statement','ISP-2026-09';
insert into bank_transactions (id,bank_statement_id,bank_account_id,date,particulars,bank_channel,check_number,amount,direction,category,invoice_id,expense_id,po_number,source_type,source_id)
select 'TXN-2026-018','STMT-2026-09',(select id from bank_accounts limit 1),'2026-09-09','Printer ink & paper','Bank Transfer',null,2380,'Withdrawal','Other',null,'EXP-0922',null,'Supplier Receipt','OR-12044';
insert into bank_transactions (id,bank_statement_id,bank_account_id,date,particulars,bank_channel,check_number,amount,direction,category,invoice_id,expense_id,po_number,source_type,source_id)
select 'TXN-2026-019','STMT-2026-09',(select id from bank_accounts limit 1),'2026-09-11','Steel angle bars','Check','SI-31502',4820,'Withdrawal','Materials',null,'EXP-0907','PO-2026-0104','Supplier Receipt','SI-31502';
insert into bank_transactions (id,bank_statement_id,bank_account_id,date,particulars,bank_channel,amount,direction,category,invoice_id,expense_id,po_number,source_type,source_id)
select 'TXN-2026-020','STMT-2026-09',(select id from bank_accounts limit 1),'2026-09-13','Client payment — INV-2026-001','Bank Credit',(select collection_amount from invoices where id='INV-2026-001'),'Deposit','Client Payment','INV-2026-001',null,'PO-2026-0103','Invoice','INV-2026-001';
insert into bank_transactions (id,bank_statement_id,bank_account_id,date,particulars,bank_channel,check_number,amount,direction,category,invoice_id,expense_id,po_number,source_type,source_id)
select 'TXN-2026-021','STMT-2026-09',(select id from bank_accounts limit 1),'2026-09-13','New cutting tools','Check','OR-70388',28330,'Withdrawal','Other',null,'EXP-0919',null,'Supplier Receipt','OR-70388';
insert into bank_transactions (id,bank_statement_id,bank_account_id,date,particulars,bank_channel,check_number,amount,direction,category,invoice_id,expense_id,po_number,source_type,source_id)
select 'TXN-2026-022','STMT-2026-09',(select id from bank_accounts limit 1),'2026-09-18','Toll & parking','Bank Transfer',null,4100,'Withdrawal','Other',null,'EXP-0927',null,'Supplier Receipt','TOLL-0918';
insert into bank_transactions (id,bank_statement_id,bank_account_id,date,particulars,bank_channel,amount,direction,category,invoice_id,expense_id,po_number,source_type,source_id)
select 'TXN-2026-023','STMT-2026-09',(select id from bank_accounts limit 1),'2026-09-21','Client payment — INV-2026-002','Bank Credit',(select collection_amount from invoices where id='INV-2026-002'),'Deposit','Client Payment','INV-2026-002',null,'PO-2026-0104','Invoice','INV-2026-002';
insert into bank_transactions (id,bank_statement_id,bank_account_id,date,particulars,bank_channel,check_number,amount,direction,category,invoice_id,expense_id,po_number,source_type,source_id)
select 'TXN-2026-024','STMT-2026-09',(select id from bank_accounts limit 1),'2026-09-21','SUS304 sheets — supplier','Bank Transfer',null,33960,'Withdrawal','Materials',null,'EXP-0908','PO-2026-0104','Supplier Receipt','SI-31655';
insert into bank_transactions (id,bank_statement_id,bank_account_id,date,particulars,bank_channel,check_number,amount,direction,category,invoice_id,expense_id,po_number,source_type,source_id)
select 'TXN-2026-025','STMT-2026-09',(select id from bank_accounts limit 1),'2026-09-26','Payroll Sep 11–25, 2026','Bank Transfer',null,(select amount from expenses where id='EXP-0904'),'Withdrawal','Payroll',null,'EXP-0904',null,'Payroll',(select id::text from payroll_runs limit 1);
insert into bank_transactions (id,bank_statement_id,bank_account_id,date,particulars,bank_channel,check_number,amount,direction,category,invoice_id,expense_id,po_number,source_type,source_id)
select 'TXN-2026-026','STMT-2026-09',(select id from bank_accounts limit 1),'2026-09-30','Petty cash replenishment — September 2026','Bank Transfer',null,(select coalesce(sum(l.amount),0) from petty_cash_voucher_lines l join petty_cash_vouchers v on v.id=l.voucher_id where v.petty_cash_period_id='PCFP-2026-09'),'Withdrawal','PCF Replenishment',null,null,null,'Petty Cash','PCFP-2026-09';
update petty_cash_periods set replenishment_bank_transaction_id='TXN-2026-026' where id='PCFP-2026-09';
insert into bank_transactions (id,bank_statement_id,bank_account_id,date,particulars,bank_channel,check_number,amount,direction,category,invoice_id,expense_id,po_number,source_type,source_id)
select 'TXN-2026-027','STMT-2026-10',(select id from bank_accounts limit 1),'2026-10-03','Toll & parking','Bank Transfer',null,4330,'Withdrawal','Other',null,'EXP-0928',null,'Supplier Receipt','TOLL-1003';
insert into bank_transactions (id,bank_statement_id,bank_account_id,date,particulars,bank_channel,check_number,amount,direction,category,invoice_id,expense_id,po_number,source_type,source_id)
select 'TXN-2026-028','STMT-2026-10',(select id from bank_accounts limit 1),'2026-10-03','Delivery truck fuel','Bank Transfer',null,4570,'Withdrawal','Other',null,'EXP-0929',null,'Supplier Receipt','FUEL-1003';
insert into bank_transactions (id,bank_statement_id,bank_account_id,date,particulars,bank_channel,check_number,amount,direction,category,invoice_id,expense_id,po_number,source_type,source_id)
select 'TXN-2026-029','STMT-2026-10',(select id from bank_accounts limit 1),'2026-10-05','Warehouse monthly rent','Check','LEASE-2026-10',35000,'Withdrawal','Other',null,'EXP-0911',null,'Billing Statement','LEASE-2026-10';
insert into bank_transactions (id,bank_statement_id,bank_account_id,date,particulars,bank_channel,check_number,amount,direction,category,invoice_id,expense_id,po_number,source_type,source_id)
select 'TXN-2026-030','STMT-2026-10',(select id from bank_accounts limit 1),'2026-10-05','New cutting tools','Check','OR-70512',20650,'Withdrawal','Other',null,'EXP-0920',null,'Supplier Receipt','OR-70512';
insert into bank_transactions (id,bank_statement_id,bank_account_id,date,particulars,bank_channel,check_number,amount,direction,category,invoice_id,expense_id,po_number,source_type,source_id)
select 'TXN-2026-031','STMT-2026-10',(select id from bank_accounts limit 1),'2026-10-09','Fiber internet plan','Bank Transfer',null,1900,'Withdrawal','Other',null,'EXP-0917',null,'Billing Statement','ISP-2026-10';
insert into bank_transactions (id,bank_statement_id,bank_account_id,date,particulars,bank_channel,check_number,amount,direction,category,invoice_id,expense_id,po_number,source_type,source_id)
select 'TXN-2026-032','STMT-2026-10',(select id from bank_accounts limit 1),'2026-10-12','Printer ink & paper','Bank Transfer',null,1760,'Withdrawal','Other',null,'EXP-0923',null,'Supplier Receipt','OR-12190';

-- project material cost: BOM lines now point at the payment that bought them
update project_bom b set expense_id = p.expense_id
  from purchase_order_items i join material_requests mr on mr.id=i.material_request_id
       join purchase_order_invoices p on p.purchase_order_id=i.purchase_order_id and p.expense_id is not null
 where mr.bom_id=b.id;

-- statements: opening balance = previous closing balance; closed periods tie to the passbook
do $$
declare s record; prev numeric := 650000; endbal numeric;
begin
  for s in select * from bank_statements order by start_date loop
    endbal := prev + coalesce((select sum(case when direction='Deposit' then amount else -amount end) from bank_transactions where bank_statement_id=s.id),0);
    update bank_statements set beginning_balance=prev, passbook_ending_balance=case when status='Closed' then endbal else null end where id=s.id;
    prev := endbal;
  end loop;
end $$;

-- re-seal the hash chain over the rebuilt data
select ledger_rebuild();
commit;
