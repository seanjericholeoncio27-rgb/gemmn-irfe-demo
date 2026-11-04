-- 14_vat_inc_adds_vat.sql  (GEMMN IRFE)
-- "VAT Inc" now means the entered price is the vatable amount and 12% VAT is ADDED on top
-- (100 -> 112). It no longer back-computes 100 -> 89.29. 'exempt' stays VAT-free.
-- Re-defines the 3 project-value sync functions (triggers already exist) and recomputes
-- projects linked to 'included' / 'exempt' invoices. Safe to re-run.
create or replace function public.sync_project_from_invoice() returns trigger language plpgsql security definer as $fn$
begin
  update public.projects set value = (
    select sum(ii.qty*ii.price) * (case when bool_or(i.vat_mode = 'exempt') then 1 else 1 + coalesce(max(i.tax),0.12) end)
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
    select sum(ii.qty*ii.price) * (case when bool_or(i.vat_mode = 'exempt') then 1 else 1 + coalesce(max(i.tax),0.12) end)
    from invoice_items ii join invoices i on i.id = ii.invoice_id
    where ii.invoice_id = target_invoice_id and ii.kind = 'item')
  where invoice_id = target_invoice_id;
  return coalesce(new, old);
end; $fn$;
create or replace function public.sync_project_value_from_own_invoice_id() returns trigger language plpgsql security definer as $fn$
begin
  if new.invoice_id is not null then
    new.value := (
      select sum(ii.qty*ii.price) * (case when bool_or(i.vat_mode = 'exempt') then 1 else 1 + coalesce(max(i.tax),0.12) end)
      from invoice_items ii join invoices i on i.id = ii.invoice_id
      where ii.invoice_id = new.invoice_id and ii.kind = 'item');
  end if;
  return new;
end; $fn$;

-- Recompute projects whose invoice is 'included' (now +12%) or 'exempt' (no VAT)
update public.projects p set value = (
  select sum(ii.qty*ii.price) * (case when i.vat_mode = 'exempt' then 1 else 1 + coalesce(i.tax,0.12) end)
  from invoice_items ii join invoices i on i.id = ii.invoice_id
  where ii.invoice_id = p.invoice_id and ii.kind = 'item' group by i.vat_mode, i.tax)
where p.invoice_id in (select id from invoices where vat_mode in ('included','exempt'));
