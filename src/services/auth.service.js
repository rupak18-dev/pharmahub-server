import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

import { env } from "../config/env.js";
import { constants } from "../config/constants.js";
import { ApiError } from "../core/ApiError.js";
import { logger } from "../core/logger.js";
import { User } from "../models/User.js";
import { computeProfileCompletion } from "./profileCompletion.service.js";
import { getEffectivePermissions, normalizePermissions } from "./permissions.service.js";
import { verifyOtp } from "./otp.service.js";

export async function registerUser({ name, email, password, orgName }) {
  const normalizedEmail = email.toLowerCase();
  const existing = await User.findOne({ email: normalizedEmail }).collation({
    locale: "en",
    strength: 2,
  });
  if (existing) throw ApiError.conflict("A user with this email already exists");

  const passwordHash = await bcrypt.hash(password, 10);
  // No role is assigned here on purpose: self-registered accounts stay
  // role-less until the Owner explicitly assigns one (Users & Roles) —
  // never a silent default.
  const user = await User.create({
    name,
    email: normalizedEmail,
    passwordHash,
    orgName,
  });

  const token = signToken(user._id);
  return { token, user: toPublicUser(user) };
}

export async function updateProfile(userId, { name, role, orgName, onboarded }) {
  const user = await User.findById(userId);
  if (!user) throw ApiError.notFound("User not found");

  if (name !== undefined) user.name = name.trim();
  if (role !== undefined) {
    if (!constants.roles.includes(role.trim())) {
      throw ApiError.badRequest(`Invalid role. Must be one of: ${constants.roles.join(", ")}`);
    }
    user.role = role.trim();
  }
  if (orgName !== undefined) user.orgName = orgName?.trim() ?? null;
  if (onboarded !== undefined) user.onboarded = onboarded;

  await user.save();
  return toPublicUser(user);
}

export async function loginUser({ email, password }) {
  const normalizedEmail = email.toLowerCase();
  let user = await User.findOne({ email: normalizedEmail })
    .collation({ locale: "en", strength: 2 })
    .select("+passwordHash");

  // Demo auto-login accounts exist ONLY when explicitly enabled via
  // ENABLE_DEMO_ACCOUNTS=true outside production — never part of the normal flow.
  if (
    !user &&
    env.enableDemoAccounts &&
    !env.isProduction &&
    (normalizedEmail.endsWith("@pharmahub.demo") || normalizedEmail === "demo@pharmahub.com")
  ) {
    const passwordHash = await bcrypt.hash(env.demoAccountPassword, 10);
    const role = normalizedEmail.includes("owner")
      ? "Owner"
      : normalizedEmail.includes("admin")
        ? "Admin"
        : "Pharmacist";
    user = await User.create({
      name: `PharmaHub ${role}`,
      email: normalizedEmail,
      passwordHash,
      role,
      orgName: "PharmaHub Pharmacy",
      active: true,
      status: "active",
    });
  }

  if (!user || !user.active || user.status === "removed") {
    logger.info(`[auth.login] no active account for email=${normalizedEmail}`);
    throw ApiError.unauthorized("Invalid email or password");
  }

  // Accounts provisioned without a local password (e.g. Google sign-up) must
  // fail as unauthorized instead of crashing inside bcrypt.compare.
  if (!user.passwordHash) {
    throw ApiError.unauthorized("Invalid email or password");
  }

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) {
    logger.info(`[auth.login] bad password for email=${normalizedEmail}`);
    throw ApiError.unauthorized("Invalid email or password");
  }

  // The session credential is bound to THIS database user's id — never to a
  // role, a demo account, or any previously authenticated identity.
  const token = signToken(user._id);
  logger.info(
    `[auth.login] requested email=${normalizedEmail} -> matched user id=${user._id} role=${user.role} (session userId=${user._id})`,
  );
  const publicUser = await toAuthUser(user.toObject());
  publicUser.profileCompletion = computeProfileCompletion(user);
  return { token, user: publicUser };
}


export async function changePassword(userId, { currentPassword, newPassword }) {
  const user = await User.findById(userId).select("+passwordHash");
  if (!user) throw ApiError.notFound("User not found");

  const match = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!match) throw ApiError.badRequest("Current password is incorrect");

  if (await bcrypt.compare(newPassword, user.passwordHash)) {
    throw ApiError.badRequest("New password must be different from the current password");
  }

  user.passwordHash = await bcrypt.hash(newPassword, 10);
  await user.save();
  return true;
}

/**
 * Completes a forgot-password flow: consumes the emailed OTP, then sets the
 * new password. Google-created accounts may set their first password here.
 * Returns the user id for audit logging.
 */
export async function resetPassword({ email, code, newPassword }) {
  await verifyOtp({ email, purpose: "password_reset", code });
  const user = await User.findOne({ email: email.toLowerCase() }).collation({
    locale: "en",
    strength: 2,
  });
  if (!user || !user.active) throw ApiError.badRequest("No account found for this email");

  user.passwordHash = await bcrypt.hash(newPassword, 10);
  user.provider = "email";
  await user.save();
  return String(user._id);
}

function signToken(userId) {
  return jwt.sign({ sub: String(userId) }, env.jwtSecret, {
    algorithm: "HS256",
    issuer: "pharmahub",
    expiresIn: env.jwtExpiresIn,
  });
}

export function issueToken(userId) {
  return signToken(userId);
}

const SESSION_COOKIE_OPTIONS = {
  httpOnly: env.cookie.httpOnly,
  secure: env.cookie.secure,
  sameSite: env.cookie.sameSite,
  path: "/",
};

export function setSessionCookie(res, token, { remember = true } = {}) {
  const options = { ...SESSION_COOKIE_OPTIONS };
  // remember=false → browser-session cookie (no Max-Age): signing in ends when
  // the browser closes, matching the frontend's sessionStorage choice.
  if (remember !== false) {
    options.maxAge = env.cookie.maxAgeDays * 24 * 60 * 60 * 1000;
  }
  res.cookie(env.cookie.name, token, options);
}

export function clearSessionCookie(res) {
  res.clearCookie(env.cookie.name, {
    ...SESSION_COOKIE_OPTIONS,
  });
}

export function toPublicUser(user) {
  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    phone: user.phone ?? null,
    role: user.role,
    orgName: user.orgName,
    active: user.active,
    onboarded: user.onboarded ?? true,
    status: user.status ?? (user.active ? "active" : "suspended"),
    removedAt: user.removedAt ?? null,
    removedBy: user.removedBy ? String(user.removedBy) : null,
    phoneVerified: user.phoneVerified ?? false,
    phoneVerifiedAt: user.phoneVerifiedAt ?? null,
    avatarUrl: user.avatarUrl ?? null,
    logoUrl: user.logoUrl ?? null,
    tagline: user.tagline ?? null,
    description: user.description ?? null,
    businessEmail: user.businessEmail ?? null,
    website: user.website ?? null,
    address: user.address ?? null,
    city: user.city ?? null,
    state: user.state ?? null,
    pincode: user.pincode ?? null,
    gstin: user.gstin ?? null,
    licenseNo: user.licenseNo ?? null,
    businessType: user.businessType ?? null,
    services: user.services ?? null,
    businessHours: user.businessHours ?? null,
    metaPixelId: user.metaPixelId ?? null,
    branches: user.branches ?? [],
    permissions: normalizePermissions(user.permissions),
    featureAccess: user.featureAccess ?? {},
    accessIds: user.accessIds ?? [],
    department: user.department ?? null,
    designation: user.designation ?? null,
    invitedBy: user.invitedBy ? String(user.invitedBy) : null,
    createdBy: user.createdBy ? String(user.createdBy) : null,
    profileCompletion: user.profileCompletion ?? null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export async function toAuthUser(user) {
  const publicUser = toPublicUser(user);
  publicUser.permissions = await getEffectivePermissions(user);
  return publicUser;
}
