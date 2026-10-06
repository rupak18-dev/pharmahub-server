import { connectDB, disconnectDB } from "../src/config/db.js";
import { Role } from "../src/models/Role.js";
import { ensureAdminAccount } from "../src/services/adminSeed.service.js";
import { logger } from "../src/core/logger.js";

async function run() {
  try {
    await connectDB();
    await Role.ensureSystemRoles();
    const admin = await ensureAdminAccount();
    console.log("-----------------------------------------");
    console.log("Admin Support account ready:");
    console.log(`Email: ${admin.email}`);
    console.log(`Role:  ${admin.role}`);
    console.log(`Name:  ${admin.name}`);
    console.log("-----------------------------------------");
    await disconnectDB();
    process.exit(0);
  } catch (err) {
    logger.error("Failed to seed admin account:", err);
    process.exit(1);
  }
}

run();
