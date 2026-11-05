-- 15_restore_vat_inc_semantics.sql  (GEMMN IRFE)
-- Supersedes 14_vat_inc_adds_vat.sql. "VAT Inc" = the LINE prices already include 12% VAT
-- (the Cost Builder price x 1.12 is stored on the line), so an invoice's total is the plain
-- sum of its lines and project value must NOT add 12% again. 'exempt' is also VAT-free.
-- Re-defines the 3 project-value sync functions and recomputes projects linked to
-- 'included' / 'exempt' invoices. Safe to re-run (also safe if 14 was never run).
create or replace function public.sync_project_from_invoice() returns trigger language plpgsql security definer as $fn$
begin
  update public.projects set value = (
    select sum(ii.qty*ii.price) * (case when bool_or(i.vat_mode in ('included','exempt')) then 1 else 1 + coalesce(max(i.tax),0.12) end)
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
    select sum(ii.qty*ii.price) * (case when bool_or(i.vat_mode in ('included','exempt')) then 1 else 1 + coalesce(max(i.tax),0.12) end)
    from invoice_items ii join invoices i on i.id = ii.invoice_id
    where ii.invoice_id = target_invoice_id and ii.kind = 'item')
  where invoice_id = target_invoice_id;
  return coalesce(new, old);
end; $fn$;
create or replace function public.sync_project_value_from_own_invoice_id() returns trigger language plpgsql security definer as $fn$
begin
  if new.invoice_id is not null then
    new.value := (
      select sum(ii.qty*ii.price) * (case when bool_or(i.vat_mode in ('included','exempt')) then 1 else 1 + coalesce(max(i.tax),0.12) end)
      from invoice_items ii join invoices i on i.id = ii.invoice_id
      where ii.invoice_id = new.invoice_id and ii.kind = 'item');
  end if;
  return new;
end; $fn$;

update public.projects p set value = (
  select sum(ii.qty*ii.price) from invoice_items ii where ii.invoice_id = p.invoice_id and ii.kind = 'item')
where p.invoice_id in (select id from invoices where vat_mode in ('included','exempt'));
