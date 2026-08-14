import { asyncHandler } from "../core/asyncHandler.js";
import { ok, created } from "../core/responses.js";
import { loginUser, registerUser, changePassword, updateProfile, toPublicUser, setSessionCookie, clearSessionCookie } from "../services/auth.service.js";
import { recordAudit } from "../services/audit.service.js";

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
  setSessionCookie(res, result.token);
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

export const logout = asyncHandler(async (req, res) => {
  clearSessionCookie(res);
  return ok(res, null, "Signed out");
});

export const me = asyncHandler(async (req, res) => {
  return ok(res, toPublicUser(req.user), "Current user");
});

export const updatePassword = asyncHandler(async (req, res) => {
  await changePassword(req.user._id, req.body);
  return ok(res, null, "Password updated");
});

export const updateMyProfile = asyncHandler(async (req, res) => {
  const user = await updateProfile(req.user._id, req.body);
  recordAudit({
    userId: user.id,
    userName: user.name,
    action: "User profile updated",
    entityType: "user",
    entityId: user.id,
    ip: req.ip,
  });
  return ok(res, user, "Profile updated");
});
