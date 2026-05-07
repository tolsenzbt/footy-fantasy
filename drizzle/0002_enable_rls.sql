-- Enable RLS on all public tables.
-- service_role bypasses RLS by default in Supabase; explicit policies are added for clarity.
-- anon and authenticated roles get no access until application-level policies are added.

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'DROP POLICY IF EXISTS "service_role_full_access" ON public.%I',
      t
    );
    EXECUTE format(
      'CREATE POLICY "service_role_full_access" ON public.%I
         AS PERMISSIVE FOR ALL TO service_role
         USING (true) WITH CHECK (true)',
      t
    );
  END LOOP;
END $$;
