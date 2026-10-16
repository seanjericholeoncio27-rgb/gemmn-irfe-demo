-- 11_populate_empty_modules.sql
-- Fills the modules that were empty (October deposits, outstanding checks, cash advances,
-- employee loans, equipment loans, equipment assignments/usage, expense & quotation templates)
-- with data that is LINKED to the rest of the system. Insert/update only; safe to re-run.

-- 1. October collection: INV-2026-003 (Sunrise Foods) paid early -> deposit -> project completed
update invoices set status='Paid', cr_number='CR-502', collection_date='2026-10-12', collection_amount=227248
 where id='INV-2026-003' and status <> 'Paid';
update projects set status='Completed', progress=100, cr_number='CR-502', collection_date='2026-10-12',
       date_collected='2026-10-12', collection_amount=227248, payment_status='Paid'
 where po_number='PO-2026-0106';
insert into bank_transactions (id, bank_statement_id, bank_account_id, date, particulars, bank_channel, amount, direction, category, invoice_id, po_number, source_type, source_id)
select 'TXN-2026-OCT-01','STMT-2026-10','BANK-001','2026-10-12','Client payment — INV-2026-003','Bank Credit',227248,'Deposit','Client Payment','INV-2026-003','PO-2026-0106','Invoice','INV-2026-003'
where not exists (select 1 from bank_transactions where id='TXN-2026-OCT-01');
insert into project_timeline (po_number, event_type, event_date, notes, created_by_name, source)
select 'PO-2026-0106','Payment Collected','2026-10-12','Payment received — CR-502','Demo Admin','manual'
where not exists (select 1 from project_timeline where po_number='PO-2026-0106' and event_type='Payment Collected');

-- 2. Cash advances (bank withdrawal -> advance record -> partial repayment)
insert into bank_transactions (id, bank_statement_id, bank_account_id, date, particulars, bank_channel, amount, direction, category, source_type, source_id)
select * from (values
 ('TXN-2026-OCT-02','STMT-2026-10','BANK-001',date '2026-10-02','Cash advance — Mark Soriano','Online Transfer',6000::numeric,'Withdrawal','Cash Advance','Cash Advance','CA-EMP-005-01'),
 ('TXN-2026-OCT-03','STMT-2026-10','BANK-001',date '2026-10-06','Cash advance — Paolo Bautista','Online Transfer',4000::numeric,'Withdrawal','Cash Advance','Cash Advance','CA-EMP-008-01')
) v(a,b,c,d,e,f,g,h,i,j,k) where not exists (select 1 from bank_transactions t where t.id=v.a);
insert into cash_advances (id, employee_id, date_issued, amount, balance, status, notes, bank_transaction_id)
select * from (values
 ('CA-EMP-005-01','EMP-005',date '2026-10-02',6000::numeric,6000::numeric,'Open','Medical expense — to be deducted next payroll','TXN-2026-OCT-02'),
 ('CA-EMP-008-01','EMP-008',date '2026-10-06',4000::numeric,4000::numeric,'Open','Family emergency','TXN-2026-OCT-03')
) v(a,b,c,d,e,f,g,h) where not exists (select 1 from cash_advances x where x.id=v.a);
insert into cash_advance_payments (cash_advance_id, amount, date, method, notes)
select 'CA-EMP-008-01',1000,'2026-10-12','Cash','Partial repayment' where not exists (select 1 from cash_advance_payments where cash_advance_id='CA-EMP-008-01');
update cash_advances c set balance = c.amount - coalesce((select sum(amount) from cash_advance_payments p where p.cash_advance_id=c.id),0)
 where c.id in ('CA-EMP-005-01','CA-EMP-008-01');
update cash_advances set status = case when balance<=0 then 'Closed' else 'Open' end where id in ('CA-EMP-005-01','CA-EMP-008-01');

-- 3. Employee loans (SSS / Pag-IBIG) with installments paid
insert into employee_loans (id, employee_id, loan_type, date_issued, principal, installment_amount, balance, status, notes)
select * from (values
 ('LN-EMP-003-01','EMP-003','SSS',date '2026-07-15',12000::numeric,1000::numeric,12000::numeric,'Open','SSS salary loan — monthly deduction'),
 ('LN-EMP-009-01','EMP-009','Pag-IBIG',date '2026-06-01',20000::numeric,1500::numeric,20000::numeric,'Open','Pag-IBIG multi-purpose loan')
) v(a,b,c,d,e,f,g,h,i) where not exists (select 1 from employee_loans x where x.id=v.a);
insert into loan_payments (loan_id, amount, date, method, notes)
select l, a, d::date, 'Payroll Deduction', n from (values
 ('LN-EMP-003-01',1000::numeric,'2026-08-25','Installment 1'),('LN-EMP-003-01',1000,'2026-09-25','Installment 2'),
 ('LN-EMP-009-01',1500,'2026-07-10','Installment 1'),('LN-EMP-009-01',1500,'2026-08-10','Installment 2'),('LN-EMP-009-01',1500,'2026-09-10','Installment 3')
) v(l,a,d,n) where not exists (select 1 from loan_payments p where p.loan_id=v.l and p.notes=v.n);
update employee_loans e set balance = e.principal - coalesce((select sum(amount) from loan_payments p where p.loan_id=e.id),0)
 where e.id in ('LN-EMP-003-01','LN-EMP-009-01');
update employee_loans set status = case when balance<=0 then 'Closed' else 'Open' end where id in ('LN-EMP-003-01','LN-EMP-009-01');

-- 4. Equipment financing: forklift loan; October instalment paid from the bank (expense -> bank -> payment)
insert into equipment_loans (id, equipment_id, date_acquired, principal, installment_amount, balance, status, vendor, notes)
select 'EQL-EQ-012','EQ-012','2025-12-05',336000,14000,336000,'Financing','Toyota Material Handling (Sample)','80% of unit price financed over 24 months'
where not exists (select 1 from equipment_loans where id='EQL-EQ-012');
insert into equipment_loan_payments (loan_id, amount, date, method, notes)
select 'EQL-EQ-012',14000,d::date,'Bank Transfer','Instalment (before system go-live)'
from unnest(array['2026-01-05','2026-02-05','2026-03-05','2026-04-05','2026-05-05','2026-06-05','2026-07-05']) d
where not exists (select 1 from equipment_loan_payments where loan_id='EQL-EQ-012');
insert into expenses (id, date, category, description, amount, payment_method, receipt, status, source_type, source_id)
select 'EXP-1201','2026-10-05','Equipment','Forklift loan instalment — EQL-EQ-012',14000,'Bank Transfer','EQL-EQ-012-OCT','Paid','Equipment Loan','EQL-EQ-012'
where not exists (select 1 from expenses where id='EXP-1201');
insert into bank_transactions (id, bank_statement_id, bank_account_id, date, particulars, bank_channel, amount, direction, category, expense_id, source_type, source_id)
select 'TXN-2026-OCT-04','STMT-2026-10','BANK-001','2026-10-05','Forklift loan instalment — EQL-EQ-012','Online Transfer',14000,'Withdrawal','Other','EXP-1201','Supplier Receipt','EQL-EQ-012-OCT'
where not exists (select 1 from bank_transactions where id='TXN-2026-OCT-04');
insert into equipment_loan_payments (loan_id, expense_id, amount, date, method, notes)
select 'EQL-EQ-012','EXP-1201',14000,'2026-10-05','Bank Transfer','October instalment'
where not exists (select 1 from equipment_loan_payments where loan_id='EQL-EQ-012' and expense_id='EXP-1201');
update equipment_loans e set balance = e.principal - coalesce((select sum(amount) from equipment_loan_payments p where p.loan_id=e.id),0) where id='EQL-EQ-012';
update equipment_loans set status = case when balance<=0 then 'Fully Paid' else 'Financing' end where id='EQL-EQ-012';

-- 5. Outstanding checks: issued to suppliers for open payables, not yet cleared
insert into outstanding_checks (id, bank_account_id, date_issued, particulars, check_number, amount, status, notes)
select 'CHK-2026-'||lpad(row_number() over (order by po.id)::text,3,'0'), 'BANK-001', date '2026-10-14',
       s.name||' — PO '||po.id, (70512 + row_number() over (order by po.id))::text, po.amount_invoiced, 'Outstanding', 'Issued for supplier invoice; awaiting bank clearing'
from purchase_orders po join suppliers s on s.id=po.supplier_id
where po.id in ('SPO-2026-019','SPO-2026-021')
  and not exists (select 1 from outstanding_checks);

-- 6. Equipment on projects (assignments + usage log); status matches Resources
update equipment set assigned_to='PO-2026-0105' where id in ('EQ-002','EQ-012');
update equipment set assigned_to='PO-2026-0102' where id='EQ-004';
update equipment set assigned_to='PO-2026-0101' where id='EQ-010';
insert into equipment_assignments (equipment_id, po_number, operator_name, daily_rate, start_date, end_date, notes)
select * from (values
 ('EQ-001','PO-2026-0103','Ramon Villanueva',900::numeric,date '2026-08-12',date '2026-08-20','Welding of frames'),
 ('EQ-003','PO-2026-0104','Jose Manalo',1500,date '2026-08-17',date '2026-08-21','Plate cutting'),
 ('EQ-006','PO-2026-0108',E'Eduardo Pascual',2200,date '2026-08-25',date '2026-08-28','Bending of sheet metal'),
 ('EQ-002','PO-2026-0105','Ben Aguilar',1200,date '2026-09-22',null,'TIG welding — stainless work'),
 ('EQ-012','PO-2026-0105','Leo Cabrera',1800,date '2026-09-23',null,'Material handling'),
 ('EQ-004','PO-2026-0102','Mark Soriano',150,date '2026-09-01',null,'Grinding and finishing'),
 ('EQ-010','PO-2026-0101','Nico Estrada',400,date '2026-08-18',null,'Pneumatic tools')
) v(a,b,c,d,e,f,g) where not exists (select 1 from equipment_assignments);
insert into project_equipment_usage (po_number, equipment_id, equipment_name, days_used, daily_rate, date_logged, notes)
select a.po_number, a.equipment_id, e.name,
       case when a.end_date is not null then (a.end_date - a.start_date + 1) else (date '2026-10-15' - a.start_date + 1) * 5 / 7 end,
       a.daily_rate, coalesce(a.end_date, date '2026-10-15'), a.notes
from equipment_assignments a join equipment e on e.id=a.equipment_id
where not exists (select 1 from project_equipment_usage);

-- 7. Templates
insert into expense_templates (name, category, description, amount, payment_method)
select * from (values
 ('Warehouse monthly rent','Rent','Warehouse monthly rent',35000::numeric,'Check'),
 ('Delivery truck fuel','Transportation','Delivery truck fuel',4570::numeric,'Bank Transfer'),
 ('Toll & parking','Transportation','Toll & parking',4330::numeric,'Bank Transfer'),
 ('Fiber internet plan','Internet','Fiber internet plan',1900::numeric,'Bank Transfer'),
 ('Printer ink & paper','Office','Printer ink & paper',1760::numeric,'Bank Transfer')
) v(a,b,c,d,e) where not exists (select 1 from expense_templates);
insert into quotation_templates (id, label, description, unit, cost_breakdown, materials)
select * from (values
 ('stainless-work-table','Stainless work table (1.2x2.4m)','STAINLESS STEEL WORK TABLE','UNIT',
  '{"materialMarkupPct":"10","treatmentCost":"1500","labor":[{"process":"Cutting","hours":"6","rate":"120"},{"process":"Welding","hours":"12","rate":"150"},{"process":"Finishing","hours":"4","rate":"100"}],"contingencyPct":"5","markupPct":"25","installation":"0"}'::jsonb,
  '[{"description":"SUS304 SHEET 1.2MM","qty":2,"unit":"SHT","price":9200},{"description":"SUS304 SQ. TUBE 1-1/2\"","qty":4,"unit":"LGTH","price":2098},{"description":"ADJUSTABLE LEG","qty":4,"unit":"PCS","price":350}]'::jsonb),
 ('mezzanine-rack','Steel storage rack (per bay)','STEEL STORAGE RACK, 3 LEVELS','BAY',
  '{"materialMarkupPct":"10","treatmentCost":"2500","labor":[{"process":"Cutting","hours":"10","rate":"120"},{"process":"Welding","hours":"20","rate":"150"}],"contingencyPct":"5","markupPct":"22","installation":"1500"}'::jsonb,
  '[{"description":"STEEL ANGLE BAR 2\"x2\"","qty":8,"unit":"LGTH","price":3105},{"description":"CHECKERED PLATE 3MM","qty":2,"unit":"SHT","price":4174},{"description":"ANCHOR BOLT 1/2\"","qty":8,"unit":"PCS","price":1628}]'::jsonb),
 ('handrail-gi','Handrail, GI pipe (per lot)','GI PIPE HANDRAIL','LOT',
  '{"materialMarkupPct":"10","treatmentCost":"800","labor":[{"process":"Cutting","hours":"4","rate":"120"},{"process":"Welding","hours":"8","rate":"150"}],"contingencyPct":"5","markupPct":"20","installation":"1000"}'::jsonb,
  '[{"description":"GI PIPE 1-1/2\" SCH40","qty":6,"unit":"LGTH","price":1850},{"description":"STEEL PRIMER PAINT","qty":1,"unit":"GAL","price":1250}]'::jsonb)
) v(a,b,c,d,e,f) where not exists (select 1 from quotation_templates);

select ledger_rebuild();
