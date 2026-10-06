import bcrypt from "bcryptjs";
import { connectDB, disconnectDB } from "../src/config/db.js";
import { User } from "../src/models/User.js";
import { Role } from "../src/models/Role.js";

async function seedUser() {
  const email = (process.argv[2] || "harshu.ram824@gmail.com").toLowerCase().trim();
  const password = process.argv[3] || "password123";
  const roleName = process.argv[4] || "Owner";

  console.log(`[seed-user] connecting to MongoDB...`);
  await connectDB();

  await Role.ensureSystemRoles();
  const roleDoc = await Role.findOne({ name: roleName });

  const passwordHash = await bcrypt.hash(password, 10);

  let user = await User.findOne({ email }).collation({ locale: "en", strength: 2 }).select("+passwordHash");

  if (user) {
    console.log(`[seed-user] existing user found: id=${user._id}, updating credentials and permissions...`);
    user.passwordHash = passwordHash;
    user.role = roleName;
    if (roleDoc) {
      user.roleId = roleDoc._id;
    }
    user.active = true;
    user.status = "active";
    user.emailVerified = true;
    user.onboarded = true;
    user.provider = "email";
    if (!user.name) user.name = "Harsha Vardhan";
    if (!user.orgName) user.orgName = "PharmaHub Pharmacy";
    await user.save();
    console.log(`[seed-user] successfully updated user: ${email}`);
  } else {
    console.log(`[seed-user] creating new user for ${email}...`);
    user = await User.create({
      name: "Harsha Vardhan",
      email,
      passwordHash,
      role: roleName,
      roleId: roleDoc ? roleDoc._id : null,
      orgName: "PharmaHub Pharmacy",
      active: true,
      status: "active",
      emailVerified: true,
      onboarded: true,
      provider: "email",
    });
    console.log(`[seed-user] successfully created user: ${email} (id=${user._id})`);
  }

  console.log(`\n========================================`);
  console.log(` PharmaHub Login Credentials Seeded`);
  console.log(`========================================`);
  console.log(` Email   : ${email}`);
  console.log(` Password: ${password}`);
  console.log(` Role    : ${user.role} (Full unrestricted access)`);
  console.log(` Status  : Active & Onboarded`);
  console.log(`========================================\n`);

  await disconnectDB();
}

seedUser().catch((err) => {
  console.error("[seed-user] failed:", err);
  process.exit(1);
});
