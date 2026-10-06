const { createClient } = require("@supabase/supabase-js");
const dotenv = require("dotenv");
const path = require("path");

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const supabaseUrl = (process.env.SUPABASE_URL || "").replace(/\/rest\/v1\/?$/, "");
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

if (!supabaseUrl || !supabaseKey) {
  console.error("Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in backend/.env");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const sql = `
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS reason TEXT;
NOTIFY pgrst, 'reload schema';
`;

async function columnExists() {
  const { error } = await supabase.from("patients").select("reason").limit(1);
  return !error;
}

async function run() {
  if (await columnExists()) {
    console.log("patients.reason column already exists.");
    return;
  }

  console.log("patients.reason is missing. Attempting to add via exec_sql RPC...");
  const { error } = await supabase.rpc("exec_sql", { sql });
  if (error) {
    console.error(`Failed via RPC: ${error.message}`);
    console.log("\nRun this SQL in the Supabase SQL Editor:");
    console.log("--------------------------------------------------------------------------------");
    console.log(sql.trim());
    console.log("--------------------------------------------------------------------------------");
    process.exit(1);
  }

  if (!(await columnExists())) {
    console.error("RPC reported success but patients.reason is still missing.");
    process.exit(1);
  }

  console.log("patients.reason column is now available.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
