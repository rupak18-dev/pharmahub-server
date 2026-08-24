import bcrypt from "bcryptjs";

import { constants } from "../config/constants.js";
import { env } from "../config/env.js";
import { logger } from "../core/logger.js";
import { User } from "../models/User.js";

// Creates the single local-development demo login account
// (demo@pharmahub.local, role Owner) via find-or-create.
// Idempotent: restarting the server or re-running the seed never creates a
// duplicate. Runs ONLY when explicitly opted in via ENABLE_DEV_DEMO_USER=true
// and never in production or test environments.
export async function ensureDevelopmentUser() {
  if (process.env.ENABLE_DEV_DEMO_USER !== "true") {
    return { created: false, skipped: "ENABLE_DEV_DEMO_USER not enabled" };
  }
  if (env.isProduction || env.isTest) {
    return { created: false, skipped: "not development" };
  }

  const demo = constants.development.demoOwner;
  const existing = await User.findOne({ email: demo.email }).collation({
    locale: "en",
    strength: 2,
  });
  if (existing) {
    logger.info(`[dev-user] demo account already exists (${demo.email})`);
    return { created: false, existing: true };
  }

  await User.create({
    name: demo.name,
    email: demo.email,
    passwordHash: await bcrypt.hash(demo.password, 10),
    role: demo.role,
    orgName: demo.orgName,
    status: "active",
    active: true,
    onboarded: true,
  });
  logger.info(`[dev-user] demo account created (${demo.email})`);
  return { created: true };
}
