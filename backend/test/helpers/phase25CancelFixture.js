// Shared synthetic fixture for the R2.1/R2.2 cancel_patient_visit draft tests.
// Test-only: reads the revision 2 SQL from its proposal document and the real Node
// resolver functions from source text. Never loads .env, dotenv or the Supabase client.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repo = path.join(__dirname, "..", "..", "..");
const read = (relative) => fs.readFileSync(path.join(repo, relative), "utf8");

const CANCEL = "public.cancel_patient_visit(bigint,uuid,text,text,text,uuid,text,text,text)";
const HELPER = "public.qms_resolve_doctor_counter(text)";

// Phase 2, A, 2.1, B and 2.2, in the order the revision 2 proposal requires.
const MIGRATIONS = [
  "backend/scripts/20261010-phase2-consultation-lifecycle.sql",
  "backend/scripts/20261012-phase-a-auth-presence.sql",
  "backend/scripts/20261012-phase21-stale-recovery.sql",
  "backend/scripts/20261014-phase-b-records.sql",
  "backend/scripts/20261014-phase22-undo-waiting.sql"
];

function proposalSql() {
  const doc = read("docs/phase25-cancel-atomicity-proposal-rev2.md");
  const block = doc.slice(doc.indexOf("## 4. Draft SQL")).match(/```sql\r?\n([\s\S]*?)```/);
  assert.ok(block, "revision 2 SQL block not found");
  return block[1];
}

// The real Node function, evaluated from source without loading queueService.
function nodeFunction(name) {
  const source = read("backend/src/services/queueService.js");
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  const end = source.slice(start).search(/\r?\n\}\r?\n/);
  return new Function(`${source.slice(start, start + end)}\n}\nreturn ${name};`)();
}

// Synthetic base tables modelled on backend/supabase/City_health--Queuing.sql
// (never that script itself: it truncates counters and seeds accounts).
const BASE_SCHEMA = `
  CREATE TYPE public.queue_status AS ENUM ('waiting', 'serving', 'completed', 'cancelled', 'no-show');
  CREATE TYPE public.user_role AS ENUM ('superadmin', 'admin');
  CREATE TABLE public.patients (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    id_num varchar(100) NOT NULL, queue_number varchar(20) NOT NULL, service_type varchar(100) NOT NULL,
    status public.queue_status NOT NULL DEFAULT 'waiting',
    called_at timestamptz, completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
    counter_id varchar(100), reason text, priority_score integer DEFAULT 0,
    vulnerability_flags jsonb DEFAULT '[]'::jsonb, mobile_number varchar(20)
  );
  CREATE TABLE public.counters (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, id_num varchar(100) NOT NULL UNIQUE,
    service_types jsonb NOT NULL DEFAULT '[]'::jsonb, is_online boolean NOT NULL DEFAULT true,
    current_patient_id bigint REFERENCES public.patients(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE public.users (
    id_num varchar(100) PRIMARY KEY, password varchar(255) NOT NULL,
    role public.user_role NOT NULL DEFAULT 'admin', doctor_name varchar(100)
  );
  ALTER TABLE public.counters ENABLE ROW LEVEL SECURITY;
`;

// Supabase grants new public functions and tables to the API roles by default.
const SUPABASE_DEFAULT_PRIVILEGES = `
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
`;

const ACCOUNTS = {
  admin1: ["admin", "Doctor 1"], admin2: ["admin", "Doctor 2"], admin3: ["admin", "Doctor 3"],
  frontdesk: ["admin", null], frontdesk2: ["admin", "Front Desk"], superadmin: ["superadmin", null]
};

// Patients: 1 waiting GP, 2 GP in consultation (Doctor 1), 3 OB called (Doctor 2),
// 4 completed, 5 no-show, 6 cancelled, 7 orphan serving, 8 waiting FP.
const SEED = `
  TRUNCATE public.staff_auth_activity, public.staff_auth_sessions, public.counters,
    public.patients, public.users RESTART IDENTITY CASCADE;
  INSERT INTO public.users (id_num, password, role, doctor_name) VALUES
    ('admin1', 'synthetic', 'admin', 'Doctor 1'), ('admin2', 'synthetic', 'admin', 'Doctor 2'),
    ('admin3', 'synthetic', 'admin', 'Doctor 3'), ('frontdesk', 'synthetic', 'admin', NULL),
    ('frontdesk2', 'synthetic', 'admin', 'Front Desk'), ('superadmin', 'synthetic', 'superadmin', NULL);
  INSERT INTO public.patients (id_num, queue_number, service_type, status, counter_id,
      created_at, called_at, consultation_started_at, completed_at, reason) VALUES
    ('Synthetic 1 waiting GP', 'GP-001', 'consultation', 'waiting', NULL,
      '2000-01-01 08:00:00.123456+00', NULL, NULL, NULL, NULL),
    ('Synthetic 2 in consultation', 'GP-002', 'consultation', 'serving', 'Doctor 1',
      '2000-01-01 08:01:00.111111+00', '2000-01-01 08:05:00.222222+00', '2000-01-01 08:06:00.333333+00', NULL, NULL),
    ('Synthetic 3 called OB', 'OB-001', 'prenatal', 'serving', 'Doctor 2',
      '2000-01-01 08:02:00+00', '2000-01-01 08:07:00.444444+00', NULL, NULL, NULL),
    ('Synthetic 4 completed', 'GP-003', 'consultation', 'completed', 'Doctor 1',
      '2000-01-01 07:00:00+00', '2000-01-01 07:05:00+00', '2000-01-01 07:06:00+00', '2000-01-01 07:20:00+00', 'Done'),
    ('Synthetic 5 no-show', 'FP-001', 'family_planning', 'no-show', 'Doctor 3',
      '2000-01-01 07:10:00+00', '2000-01-01 07:15:00+00', NULL, '2000-01-01 07:30:00+00', 'Absent'),
    ('Synthetic 6 cancelled', 'GP-004', 'consultation', 'cancelled', 'Doctor 1',
      '2000-01-01 07:40:00+00', NULL, NULL, '2000-01-01 07:45:00+00', 'Original reason'),
    ('Synthetic 7 orphan serving', 'GP-005', 'consultation', 'serving', NULL,
      '2000-01-01 08:03:00+00', '2000-01-01 08:08:00+00', NULL, NULL, NULL),
    ('Synthetic 8 waiting FP', 'FP-002', 'family_planning', 'waiting', NULL,
      '2000-01-01 08:04:00+00', NULL, NULL, NULL, NULL);
  INSERT INTO public.counters (id_num, service_types, current_patient_id) VALUES
    ('Doctor 1', '["consultation","checkup"]', 2), ('Doctor 2', '["prenatal","maternity"]', 3),
    ('Doctor 3', '["family_planning"]', NULL);
`;

module.exports = {
  repo, read, CANCEL, HELPER, MIGRATIONS, proposalSql, nodeFunction,
  BASE_SCHEMA, SUPABASE_DEFAULT_PRIVILEGES, ACCOUNTS, SEED
};
