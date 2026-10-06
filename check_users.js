const supabase = require("./backend/src/lib/supabase");
const bcrypt = require("bcryptjs");

async function checkUsers() {
  console.log("Checking users in the database...");
  
  try {
    const { data, error } = await supabase
      .from("users")
      .select("id_num, role, doctor_name, password");
    
    if (error) {
      console.error("Error fetching users:", error);
      return;
    }
    
    console.log("\nUsers found in database:");
    console.log("=".repeat(60));
    
    data.forEach((user, index) => {
      console.log(`${index + 1}. Username: ${user.id_num}`);
      console.log(`   Role: ${user.role}`);
      console.log(`   Doctor Name: ${user.doctor_name || "N/A"}`);
      console.log(`   Password starts with $2b$: ${user.password?.startsWith("$2b$") || user.password?.startsWith("$2a$") ? "Yes" : "No"}`);
      console.log("---");
    });
    
    // Test password for admin1
    if (data.find(u => u.id_num === "admin1")) {
      console.log("\nTesting admin1 login...");
      const testPassword = "admin123";
      const admin1 = data.find(u => u.id_num === "admin1");
      
      let isMatch = false;
      if (admin1.password && (admin1.password.startsWith("$2a$") || admin1.password.startsWith("$2b$"))) {
        isMatch = await bcrypt.compare(testPassword, admin1.password);
      } else {
        isMatch = testPassword === admin1.password;
      }
      
      console.log(`Password test for admin1 (password: admin123): ${isMatch ? "✅ SUCCESS" : "❌ FAILED"}`);
    }
    
  } catch (err) {
    console.error("Unexpected error:", err);
  }
}

checkUsers();
