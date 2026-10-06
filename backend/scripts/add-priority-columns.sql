-- Migration: Add priority_score and vulnerability_flags to patients table
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS priority_score integer DEFAULT 0;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS vulnerability_flags jsonb DEFAULT '[]'::jsonb;

-- Update existing data if possible (extract from counter_id if it's JSON)
UPDATE public.patients 
SET 
  priority_score = (counter_id::jsonb->>'score')::integer,
  vulnerability_flags = (counter_id::jsonb->'flags')::jsonb
WHERE 
  counter_id LIKE '{%score%';

-- Clean up counter_id if it was used for JSON (only for patients who are not being served)
UPDATE public.patients
SET counter_id = NULL
WHERE 
  counter_id LIKE '{%score%' AND status = 'waiting';

-- Refresh the schema cache
NOTIFY pgrst, 'reload schema';
