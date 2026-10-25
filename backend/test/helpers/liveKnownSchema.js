// Synthetic model of the development project's KNOWN schema, for disposable in-memory
// PostgreSQL (PGlite) tests only. Unlike postgresSchema.js it mirrors what the 2026-10-23
// read-only metadata probe and the 2026-10-16 catalog export reported:
//   * patients has no first_name / last_name (names are stored in id_num);
//   * users has no created_at; id_num is the primary key;
//   * queue_status has no 'no-show';
//   * users / patients / counters have RLS enabled (not forced) with no policies, and the
//     browser roles hold broad table grants, as Supabase default privileges give them.
// It does not claim to reproduce every column, trigger or grant of the real project.
const fs = require("node:fs");
const path = require("node:path");

const scripts = path.join(__dirname, "..", "..", "scripts");
const readScript = (name) => fs.readFileSync(path.join(scripts, name), "utf8");

const supabaseRoles = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  -- Supabase grants new objects created by the installing role to every API role.
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
`;

const liveKnownSchema = `
  CREATE TYPE public.queue_status AS ENUM ('waiting', 'serving', 'completed', 'cancelled');
  CREATE TYPE public.user_role AS ENUM ('superadmin', 'admin');
  CREATE TABLE public.users (
    id_num varchar(100) PRIMARY KEY,
    password varchar(255) NOT NULL,
    role public.user_role NOT NULL DEFAULT 'admin',
    doctor_name varchar(100)
  );
  CREATE TABLE public.patients (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    id_num varchar(100) NOT NULL,
    philhealth_id varchar(100),
    mobile_number varchar(20),
    queue_number varchar(20) NOT NULL,
    service_type varchar(100) NOT NULL,
    status public.queue_status NOT NULL DEFAULT 'waiting',
    called_at timestamptz,
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    counter_id varchar(100),
    priority_score integer DEFAULT 0,
    vulnerability_flags jsonb DEFAULT '[]'::jsonb,
    source varchar(50),
    residency varchar(100),
    birthdate date,
    sex varchar(20)
  );
  CREATE TABLE public.counters (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    id_num varchar(100) NOT NULL UNIQUE,
    service_types jsonb NOT NULL DEFAULT '[]'::jsonb,
    is_online boolean NOT NULL DEFAULT true,
    current_patient_id bigint REFERENCES public.patients(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.patients ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.counters ENABLE ROW LEVEL SECURITY;
`;

// Migrations reported as installed on the development project before Phase B.2.
const INSTALLED_MIGRATIONS = [
  "20261010-phase2-consultation-lifecycle.sql",
  "20261012-phase-a-auth-presence.sql",
  "20261012-phase21-stale-recovery.sql",
  "20261014-phase22-undo-waiting.sql"
];

// Fresh database in the known pre-B.2 state. `migrations` narrows what is installed, e.g.
// to test the dependency gate.
async function liveKnownDatabase(PGlite, { migrations = INSTALLED_MIGRATIONS } = {}) {
  const db = await PGlite.create();
  await db.exec(supabaseRoles);
  await db.exec(liveKnownSchema);
  for (const name of migrations) await db.exec(readScript(name));
  return db;
}

module.exports = { liveKnownDatabase, liveKnownSchema, readScript, INSTALLED_MIGRATIONS };
