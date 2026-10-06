const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

if (!supabaseUrl || !supabaseKey) {
  console.error("Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in backend/.env");
  process.exit(1);
}

const normalizedUrl = supabaseUrl.replace(/\/rest\/v1\/?$/, "");
const supabase = createClient(normalizedUrl, supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const sqlPath = path.resolve(__dirname, "add-account-cancellation-requests.sql");
const sql = fs.readFileSync(sqlPath, "utf8");

async function run() {
  console.log("Applying account_cancellation_requests migration...");

  try {
    const { error } = await supabase.rpc("exec_sql", { sql });
    if (error) {
      throw new Error(error.message);
    }
    console.log("Migration applied via exec_sql RPC.");
    return;
  } catch (err) {
    console.error(`Failed to execute via RPC: ${err.message}`);
    console.log("\nPlease run the following SQL manually in your Supabase SQL Editor:");
    console.log("--------------------------------------------------------------------------------");
    console.log(sql);
    console.log("--------------------------------------------------------------------------------");
    process.exit(1);
  }
}

run().catch(console.error);
