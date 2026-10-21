// Synthetic base tables for disposable, in-memory PostgreSQL tests only.
// This fixture does not read or execute the application's install/seed script.
// It models the columns, enum values, keys and RLS needed by the migrations;
// it does not claim to validate an installed Supabase project's full schema.
const basePostgresSchema = `
  CREATE TYPE public.queue_status AS ENUM ('waiting', 'serving', 'completed', 'cancelled', 'no-show');
  CREATE TYPE public.user_role AS ENUM ('admin', 'superadmin');
  CREATE TABLE public.users (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    id_num text NOT NULL UNIQUE,
    password text NOT NULL,
    role public.user_role NOT NULL,
    doctor_name text
  );
  CREATE TABLE public.patients (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    id_num text NOT NULL,
    first_name text,
    last_name text,
    mobile_number text,
    queue_number text NOT NULL,
    service_type text NOT NULL,
    status public.queue_status NOT NULL DEFAULT 'waiting',
    counter_id text,
    priority_score integer NOT NULL DEFAULT 1,
    vulnerability_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    called_at timestamptz,
    completed_at timestamptz
  );
  CREATE TABLE public.counters (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    id_num text NOT NULL UNIQUE,
    service_types jsonb NOT NULL DEFAULT '[]'::jsonb,
    is_online boolean NOT NULL DEFAULT false,
    current_patient_id bigint REFERENCES public.patients(id),
    created_at timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.patients ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.counters ENABLE ROW LEVEL SECURITY;
`;

module.exports = { basePostgresSchema };
