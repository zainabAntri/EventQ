-- Close the Supabase Data API over EventQ's tables.
--
-- Supabase exposes every table in the `public` schema through PostgREST at
-- https://<ref>.supabase.co/rest/v1/<table>, authorised by the project's `anon`
-- key — a key Supabase treats as public by design. Supabase's default
-- privileges also GRANT the `anon` and `authenticated` roles full access to
-- new tables in `public`. Before this migration, anyone holding that key could
-- read `users` (password hashes included) and write to any table.
--
-- EventQ never uses that API: all access is Prisma, connecting as the role that
-- OWNS these tables. Row Level Security does not apply to a table's owner
-- (nothing here uses FORCE), so the application is unaffected by either layer.
--
-- Two independent layers:
--   1. RLS enabled on every table with NO policies: a non-owner role sees zero
--      rows and can change nothing, even if a privilege is granted later.
--   2. Every privilege revoked from `anon` and `authenticated`, now and for
--      tables created by future migrations.
--
-- Layer 2 runs only where those roles exist (Supabase), so the same migration
-- applies unchanged to local Docker and the Testcontainers suite.
--
-- A NEW TABLE MUST ENABLE RLS in its own migration. schema.integration.spec.ts
-- fails if any table in `public` does not.

DO $$
DECLARE
  target record;
  api_role text;
BEGIN
  FOR target IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', target.tablename);
  END LOOP;

  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', api_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', api_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
