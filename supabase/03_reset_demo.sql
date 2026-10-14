-- Wipes all demo data (keeps schema and demo logins). Then re-run 02_seed.sql after deleting the demo users,
-- or simply re-run only the data sections you need.
do $$ declare r record; begin
  for r in select tablename from pg_tables where schemaname='public' and tablename not in ('profiles','roles') loop
    execute format('truncate table public.%I restart identity cascade', r.tablename);
  end loop;
end $$;
