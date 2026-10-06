const { createClient } = require("@supabase/supabase-js");
const dotenv = require("dotenv");
const path = require("path");

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

if (!supabaseUrl || !supabaseKey) {
  console.error("Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in backend/.env");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

async function run() {
  console.log("Applying priority system migration...");
  
  const sqlCommands = [
    "ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS priority_score integer DEFAULT 0;",
    "ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS vulnerability_flags jsonb DEFAULT '[]'::jsonb;",
    "NOTIFY pgrst, 'reload schema';"
  ];

  for (const sql of sqlCommands) {
    console.log(`Executing: ${sql}`);
    try {
      // Attempt to use RPC if available (requires a custom 'exec_sql' function in Supabase)
      const { error: rpcError } = await supabase.rpc("exec_sql", { sql });
      
      if (rpcError) {
        throw new Error(rpcError.message);
      }
      console.log("Success!");
    } catch (err) {
      console.error(`Failed to execute via RPC: ${err.message}`);
      console.log("\nIf the RPC 'exec_sql' is not defined, please run the following SQL manually in your Supabase SQL Editor:");
      console.log("--------------------------------------------------------------------------------");
      console.log(sqlCommands.join("\n"));
      console.log("--------------------------------------------------------------------------------");
      process.exit(1);
    }
  }

  console.log("\nMigration completed successfully! The 'priority_score' and 'vulnerability_flags' columns should now be available.");
}

run().catch(console.error);
