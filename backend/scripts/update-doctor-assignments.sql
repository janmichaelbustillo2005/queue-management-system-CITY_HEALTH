-- Update Doctor Assignments
-- Doctor 1: General Consultation and Medical Check-up
UPDATE public.counters 
SET service_types = '["consultation", "checkup"]'::jsonb 
WHERE id_num = 'Doctor 1';

-- Doctor 2: Prenatal and Maternity Services
UPDATE public.counters 
SET service_types = '["prenatal", "maternity"]'::jsonb 
WHERE id_num = 'Doctor 2';

-- Doctor 3: Family Planning Services
UPDATE public.counters 
SET service_types = '["family_planning"]'::jsonb 
WHERE id_num = 'Doctor 3';

-- Refresh cache
NOTIFY pgrst, 'reload schema';
