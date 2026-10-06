const { createClient } = require("@supabase/supabase-js");
const env = require("../config/env");

if (!env.supabaseUrl || !env.supabaseServiceRoleKey) {
  console.warn("Supabase environment variables are missing. API requests will fail until they are configured.");
}

function normalizeSupabaseUrl(url) {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch (error) {
    return url;
  }
}

const supabaseUrl = normalizeSupabaseUrl(env.supabaseUrl || "https://example.supabase.co");
const supabase = createClient(supabaseUrl, env.supabaseServiceRoleKey || "missing-key", {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

module.exports = supabase;
