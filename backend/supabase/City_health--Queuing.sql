-- Database: City_health--Queuing
-- Description: Schema for City Health Queuing Management System (Email-free)

-- Note: In Supabase, the database name is typically managed in the project settings.
-- This script provides the schema setup for the "public" schema within the database.

-- Create custom types
DO $$ BEGIN
    CREATE TYPE queue_status AS ENUM ('waiting', 'serving', 'completed', 'cancelled');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE user_role AS ENUM ('superadmin', 'admin');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Patients Table (No email field)
create table if not exists public.patients (
  id bigint generated always as identity primary key,
  id_num varchar(100) not null, -- Citizen ID or other identifier
  philhealth_id varchar(100),
  first_name varchar(100) not null,
  last_name varchar(100) not null,
  mobile_number varchar(20) not null,
  queue_number varchar(20) not null,
  service_type varchar(100) not null,
  status queue_status not null default 'waiting',
  called_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

-- Ensure later-added patient columns exist on older databases
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS counter_id varchar(100);
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS priority_score integer DEFAULT 0;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS vulnerability_flags jsonb DEFAULT '[]'::jsonb;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS source varchar(50);
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS residency varchar(100);
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS birthdate date;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS sex varchar(20);

-- Counters Table
create table if not exists public.counters (
  id bigint generated always as identity primary key,
  id_num varchar(100) not null unique,
  service_types jsonb not null default '[]'::jsonb,
  is_online boolean not null default true,
  current_patient_id bigint references public.patients(id) on delete set null,
  created_at timestamptz not null default now()
);

-- Display Settings Table
create table if not exists public.display_settings (
  id bigint generated always as identity primary key,
  company_name varchar(100) default 'City Health Service Center',
  department_name varchar(100) default 'CHO & Family Planning Center Cabadbaran City',
  welcome_message text default 'Welcome to City Health Queuing System',
  refresh_interval integer default 10
);

-- Users Table (No email field)
create table if not exists public.users (
  id_num varchar(100) primary key,
  password varchar(255) not null,
  role user_role not null default 'admin',
  doctor_name varchar(100)
);

-- Ensure columns exist if table already existed
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='role') THEN
        ALTER TABLE public.users ADD COLUMN role user_role NOT NULL DEFAULT 'admin';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='doctor_name') THEN
        ALTER TABLE public.users ADD COLUMN doctor_name varchar(100);
    END IF;
END $$;

-- Account Cancellation Requests
DO $$ BEGIN
    CREATE TYPE cancellation_request_status AS ENUM ('pending', 'approved', 'rejected');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

create table if not exists public.account_cancellation_requests (
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


-- Initial Data Seeding
-- 1. Display Settings
insert into public.display_settings (company_name, department_name, welcome_message, refresh_interval)
select 'City Health Service Center', 'CHO & Family Planning Center Cabadbaran City', 'Welcome to City Health Queuing System', 10
where not exists (select 1 from public.display_settings);

-- 2. Counters (Clear existing and seed exactly 3 doctor counters)
truncate table public.counters restart identity cascade;

insert into public.counters (id_num, service_types, is_online)
values
  ('Doctor 1', '["consultation","checkup"]'::jsonb, true),
  ('Doctor 2', '["prenatal","maternity"]'::jsonb, true),
  ('Doctor 3', '["family_planning"]'::jsonb, true);

-- 3. Seed Users (Admins and Superadmin)
-- Note: Passwords should be hashed in a real application.
-- For this setup, we'll use a placeholder or hashed value.
-- admin123 hashed with bcrypt: $2a$10$Xm7B1lX.mG.HnQ6uH2r6O.lV.m.o.v.y.p.u.b.e.r.s.e.c.r.e.t
insert into public.users (id_num, password, role, doctor_name)
values
  ('superadmin', 'superadmin123', 'superadmin', null),
  ('admin1', 'admin001', 'admin', 'Doctor 1'),
  ('admin2', 'admin002', 'admin', 'Doctor 2'),
  ('admin3', 'admin003', 'admin', 'Doctor 3')
on conflict (id_num) do 
  update set 
    password = excluded.password,
    role = excluded.role,
    doctor_name = excluded.doctor_name;
