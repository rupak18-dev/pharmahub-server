import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

import { env } from "../config/env.js";
import { ApiError } from "../core/ApiError.js";
import { User } from "../models/User.js";

export async function registerUser({ name, email, password, orgName }) {
  const normalizedEmail = email.toLowerCase();
  const existing = await User.findOne({ email: normalizedEmail }).collation({ locale: "en", strength: 2 });
  if (existing) throw ApiError.conflict("A user with this email already exists");

  // Self-registration always creates a Pharmacist; privileged roles are
  // assigned by an Owner/Admin through the users endpoint.
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await User.create({
    name,
    email: normalizedEmail,
    passwordHash,
    role: "Pharmacist",
    orgName,
  });

  return { user: toPublicUser(user) };
}

export async function loginUser({ email, password }) {
  const normalizedEmail = email.toLowerCase();
  const user = await User.findOne({ email: normalizedEmail })
    .collation({ locale: "en", strength: 2 })
    .select("+passwordHash")
    .lean();
  if (!user || !user.active) {
    throw ApiError.unauthorized("Invalid email or password");
  }

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) throw ApiError.unauthorized("Invalid email or password");

  const token = signToken(user._id);
  return { token, user: toPublicUser(user) };
}

export async function changePassword(userId, { currentPassword, newPassword }) {
  const user = await User.findById(userId).select("+passwordHash");
  if (!user) throw ApiError.notFound("User not found");

  const match = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!match) throw ApiError.badRequest("Current password is incorrect");

  user.passwordHash = await bcrypt.hash(newPassword, 10);
  await user.save();
  return true;
}

function signToken(userId) {
  return jwt.sign({ sub: String(userId) }, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn,
  });
}

export function toPublicUser(user) {
  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    role: user.role,
    orgName: user.orgName,
    active: user.active,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}
