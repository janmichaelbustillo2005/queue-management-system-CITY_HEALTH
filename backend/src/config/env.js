const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const env = {
  port: Number(process.env.PORT || 4000),
  frontendUrl: process.env.FRONTEND_URL || "http://localhost:3000",
  supabaseUrl: process.env.SUPABASE_URL || "",
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  smsSenderName: process.env.SMS_SENDER_NAME || "Smart Queuing System",
  smsGatewayAddress: process.env.SMS_GATEWAY_ADDRESS || "",
  gatewayApiToken: (process.env.GATEWAY_API_TOKEN || "").trim(),
  jwtSecret: process.env.JWT_SECRET || "default_secret"
};

module.exports = env;
