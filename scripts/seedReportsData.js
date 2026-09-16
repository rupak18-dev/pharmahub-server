import { connectDB, disconnectDB } from "../src/config/db.js";
import { User } from "../src/models/User.js";
import { seedDemoReportBills } from "../src/services/reportData.service.js";

async function run() {
  await connectDB();
  console.log("[seedReportsData] Connected to MongoDB");

  const users = await User.find().lean();
  console.log(`[seedReportsData] Found ${users.length} users to seed`);

  for (const user of users) {
    console.log(`[seedReportsData] Seeding report bills for user: ${user.name} (${user.email})...`);
    const res = await seedDemoReportBills({
      userId: user._id,
      userName: user.name,
      orgName: user.orgName || "",
    });
    console.log(`  -> Added ${res.salesAdded} sales bills, ${res.purchasesAdded} purchase bills`);
  }

  console.log("[seedReportsData] Seeding completed successfully.");
  await disconnectDB();
}

run().catch((err) => {
  console.error("[seedReportsData] Error:", err);
  process.exit(1);
});
