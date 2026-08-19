import { asyncHandler } from "../core/asyncHandler.js";
import { ok, created } from "../core/responses.js";
import { loginUser, registerUser, changePassword } from "../services/auth.service.js";
import { recordAudit } from "../services/audit.service.js";
import { User } from "../models/User.js";
import { signToken, toPublicUser } from "../services/auth.service.js";

export const register = asyncHandler(async (req, res) => {
  const result = await registerUser(req.body);
  recordAudit({
    userId: result.user?.id,
    userName: result.user?.name,
    action: "User registered",
    entityType: "user",
    entityId: result.user?.id,
    ip: req.ip,
  });
  return created(res, result.user, "Registration successful. Please sign in.");
});

export const login = asyncHandler(async (req, res) => {
  const result = await loginUser(req.body);
  recordAudit({
    userId: result.user.id,
    userName: result.user.name,
    action: "User signed in",
    entityType: "user",
    entityId: result.user.id,
    ip: req.ip,
  });
  return ok(res, result, "Login successful");
});

export const me = asyncHandler(async (req, res) => {
  return ok(res, req.user, "Current user");
});

export const updatePassword = asyncHandler(async (req, res) => {
  await changePassword(req.user._id, req.body);
  return ok(res, null, "Password updated");
});

export const updateProfile = asyncHandler(async (req, res) => {
  const { updateUserProfile } = await import("../services/auth.service.js");
  const result = await updateUserProfile(req.user._id, req.body);
  return ok(res, result, "Profile updated");
});

export const googleLogin = asyncHandler(async (req, res) => {
  let user = await User.findOne({ email: "google.user@example.com" });
  if (!user) {
    user = await User.create({
      name: "Google User",
      email: "google.user@example.com",
      passwordHash: "dummy",
      role: "Pharmacist",
      onboarded: false,
    });
  }
  const token = signToken(user._id);
  const publicUser = toPublicUser(user);
  const userBase64 = Buffer.from(JSON.stringify(publicUser)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  
  res.redirect(`http://localhost:8080/auth/callback#token=${token}&user=${userBase64}`);
});
