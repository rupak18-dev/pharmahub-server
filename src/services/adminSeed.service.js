import bcrypt from "bcryptjs";
import { User } from "../models/User.js";
import { Role } from "../models/Role.js";
import { logger } from "../core/logger.js";

export const ADMIN_SUPPORT_EMAIL = "pharmahub.team@gmail.com";
export const ADMIN_SUPPORT_DEFAULT_PASSWORD = "Pharmahub@123";

/**
 * Ensures the dedicated Admin Support account exists in MongoDB with ADMIN role,
 * hashed password, and active status.
 */
export async function ensureAdminAccount() {
  try {
    const normalizedEmail = ADMIN_SUPPORT_EMAIL.toLowerCase().trim();
    const existingUser = await User.findOne({ email: normalizedEmail })
      .collation({ locale: "en", strength: 2 })
      .select("+passwordHash");

    const adminRole = await Role.findOne({ name: "Admin" });

    if (!existingUser) {
      const passwordHash = await bcrypt.hash(ADMIN_SUPPORT_DEFAULT_PASSWORD, 10);
      const newAdmin = await User.create({
        name: "PharmaHub Admin Support",
        email: normalizedEmail,
        passwordHash,
        role: "Admin",
        roleId: adminRole?._id || null,
        orgName: "PharmaHub Support Center",
        active: true,
        status: "active",
        emailVerified: true,
        onboarded: true,
        department: "Support & Operations",
        designation: "Lead Support Admin",
      });

      logger.info(
        `[adminSeed] Dedicated Admin Support account created successfully (email: ${newAdmin.email}, role: Admin)`,
      );
      return newAdmin;
    }

    // Account exists — ensure ADMIN role, active status, and password hash are present
    let updated = false;

    if (existingUser.role !== "Admin") {
      existingUser.role = "Admin";
      if (adminRole?._id) existingUser.roleId = adminRole._id;
      updated = true;
    }

    if (!existingUser.active || existingUser.status !== "active") {
      existingUser.active = true;
      existingUser.status = "active";
      updated = true;
    }

    if (!existingUser.onboarded) {
      existingUser.onboarded = true;
      updated = true;
    }

    if (!existingUser.passwordHash) {
      existingUser.passwordHash = await bcrypt.hash(ADMIN_SUPPORT_DEFAULT_PASSWORD, 10);
      updated = true;
    }

    if (updated) {
      await existingUser.save();
      logger.info(
        `[adminSeed] Admin Support account (${existingUser.email}) verified and updated to active Admin`,
      );
    } else {
      logger.info(
        `[adminSeed] Admin Support account verified (${existingUser.email}, role: ${existingUser.role})`,
      );
    }

    return existingUser;
  } catch (error) {
    logger.error(`[adminSeed] Failed to ensure Admin Support account: ${error.message}`, error);
    throw error;
  }
}
