-- Account Cancellation Requests (Doctor → Super Admin)
-- Stores pending/approved/rejected doctor account cancellation requests.
-- Accounts are NOT deleted until a Super Admin approves the request.

DO $$ BEGIN
    CREATE TYPE cancellation_request_status AS ENUM ('pending', 'approved', 'rejected');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS public.account_cancellation_requests (
  id bigint generated always as identity primary key,
  doctor_id_num varchar(100) not null,
  doctor_name varchar(100),
  doctor_role varchar(50),
  reason text not null,
  status cancellation_request_status not null default 'pending',
  requested_at timestamptz not null default now(),
  processed_at timestamptz,
  processed_by varchar(100),
  admin_notes text
);

CREATE INDEX IF NOT EXISTS idx_account_cancellation_requests_status
  ON public.account_cancellation_requests (status);

CREATE INDEX IF NOT EXISTS idx_account_cancellation_requests_doctor
  ON public.account_cancellation_requests (doctor_id_num);

-- Prevent multiple pending requests for the same doctor
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_cancellation_requests_pending_doctor
  ON public.account_cancellation_requests (doctor_id_num)
  WHERE status = 'pending';

NOTIFY pgrst, 'reload schema';
