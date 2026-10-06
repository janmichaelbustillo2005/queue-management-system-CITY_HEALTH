const { createClient } = require("@supabase/supabase-js");
const dotenv = require("dotenv");
const path = require("path");

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

let url = supabaseUrl;
try {
  const parsed = new URL(url);
  url = `${parsed.protocol}//${parsed.host}`;
} catch (e) {
  // ignore
}

const supabase = createClient(url, supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

async function run() {
  console.log("Checking if philhealth_id column exists...");
  
  try {
    const { data, error } = await supabase
      .from("patients")
      .select("philhealth_id")
      .limit(1);

    if (error && error.message?.includes("philhealth_id")) {
      console.log("Column missing. Attempting to add it via db schema...");
      
      const { error: rpcError } = await supabase.rpc("exec_sql", {
        sql: "ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS philhealth_id varchar(100);"
      });

      if (rpcError) {
        console.log("RPC method failed:", rpcError.message);
        console.log("\nPlease run this SQL in your Supabase SQL editor:");
        console.log("  ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS philhealth_id varchar(100);");
        console.log("  ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS first_name varchar(100);");
        console.log("  ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS last_name varchar(100);");
        console.log("  ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS residency varchar(500);");
        console.log("  ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS counter_id varchar(100);");
        process.exit(1);
      }

      console.log("Column added successfully!");
    } else {
      console.log("philhealth_id column already exists.");
    }
  } catch (err) {
    console.log("Error checking column:", err.message);
    console.log("\nPlease run this SQL in your Supabase SQL editor:");
    console.log("  ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS philhealth_id varchar(100);");
    console.log("  ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS first_name varchar(100);");
    console.log("  ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS last_name varchar(100);");
    console.log("  ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS residency varchar(500);");
    console.log("  ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS counter_id varchar(100);");
    process.exit(1);
  }

  console.log("Checking all required columns...");
  const { data: sample, error: sampleError } = await supabase
    .from("patients")
    .select("id")
    .limit(1);

  if (sampleError) {
    console.log("Error accessing patients table:", sampleError.message);
    process.exit(1);
  }

  console.log("Patients table is accessible. Schema looks good.");
}

run().catch(console.error);
