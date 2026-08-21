import { asyncHandler } from "../core/asyncHandler.js";
import { ok, created } from "../core/responses.js";
import { loginUser, registerUser, changePassword, toAuthUser } from "../services/auth.service.js";
import { requestDemoLogin, verifyDemoLogin } from "../services/demo-login.service.js";
import { recordAudit } from "../services/audit.service.js";
import { computeProfileCompletion } from "../services/profileCompletion.service.js";
import { User } from "../models/User.js";
import { updateMyProfile as _updateMyProfile } from "./user.controller.js";

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

// GET /auth/me — returns the current user with full effective permissions and
// profile completion score. Delegates to the same enrichment logic used by
// GET /users/me so the frontend always gets a consistent user shape.
export const me = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).lean();
  if (!user) {
    // Middleware already verified the user exists; this is a safety fallback.
    const publicUser = await toAuthUser(req.user);
    publicUser.profileCompletion = computeProfileCompletion(req.user);
    return ok(res, publicUser, "Current user");
  }
  const publicUser = await toAuthUser(user);
  publicUser.profileCompletion = computeProfileCompletion(user);
  return ok(res, publicUser, "Current user");
});

// POST /auth/logout — JWT is stateless; logout is handled by the frontend
// clearing its stored token. This endpoint exists so the frontend can call it
// without receiving a 404 and still records the logout in the audit log.
export const logout = asyncHandler(async (req, res) => {
  recordAudit({
    userId: req.user?._id,
    userName: req.user?.name,
    action: "User signed out",
    entityType: "user",
    entityId: req.user?._id,
    ip: req.ip,
  });
  return ok(res, null, "Logged out");
});

export const updatePassword = asyncHandler(async (req, res) => {
  await changePassword(req.user._id, req.body);
  return ok(res, null, "Password updated");
});

export const demoLogin = asyncHandler(async (req, res) => {
  const result = await requestDemoLogin(req.body.email);
  return ok(res, result, "Demo login link sent to your email");
});

export const demoLoginVerify = asyncHandler(async (req, res) => {
  const result = await verifyDemoLogin(req.body.token);
  recordAudit({
    userId: result.user.id,
    userName: result.user.name,
    action: "Demo login verified",
    entityType: "user",
    entityId: result.user.id,
    ip: req.ip,
  });
  return ok(res, result, "Login successful");
});

// PUT /auth/profile — convenience alias for PUT /users/me/profile so the
// frontend auth service does not need to know about the /users prefix.
export const updateMyProfile = _updateMyProfile;
