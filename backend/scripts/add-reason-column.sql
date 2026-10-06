-- Add reason column to patients table (used for cancel / no-show / requeue notes)
ALTER TABLE public.patients
ADD COLUMN IF NOT EXISTS reason TEXT;

-- Reload PostgREST schema cache so the API sees the new column
NOTIFY pgrst, 'reload schema';
