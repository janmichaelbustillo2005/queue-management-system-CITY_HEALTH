-- Run this in your Supabase SQL editor to add missing columns
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS philhealth_id varchar(100);
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS first_name varchar(100);
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS last_name varchar(100);
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS residency varchar(500);
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS counter_id varchar(100);

-- Refresh the schema cache so PostgREST picks up the new columns
NOTIFY pgrst, 'reload schema';
