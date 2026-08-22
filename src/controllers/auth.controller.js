import crypto from "node:crypto";

import { asyncHandler } from "../core/asyncHandler.js";
import { ok, created } from "../core/responses.js";
import { env } from "../config/env.js";
import {
  loginUser,
  registerUser,
  changePassword,
  updateProfile,
  toPublicUser,
  setSessionCookie,
  clearSessionCookie,
  signInWithGoogle,
  signUpWithGoogle,
  resetPassword as resetPasswordService,
} from "../services/auth.service.js";
import {
  googleAuthUrl,
  exchangeCodeForProfile,
} from "../services/googleAuth.service.js";
import { requestDemoLogin, verifyDemoLogin } from "../services/demo-login.service.js";
import { createAndSendOtp } from "../services/otp.service.js";
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
  setSessionCookie(res, result.token, { remember: req.body.remember ?? true });
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

export const forgotPassword = asyncHandler(async (req, res) => {
  const email = req.body.email.toLowerCase();
  const user = await User.findOne({ email })
    .collation({ locale: "en", strength: 2 })
    .select("_id active")
    .lean();
  if (user?.active) {
    await createAndSendOtp({
      email,
      purpose: "password_reset",
      subject: "Reset your PharmaHub password",
      html: `<p>We received a request to reset your PharmaHub password. Enter this code to continue:</p>
<p style="font-size:24px;font-weight:bold;letter-spacing:4px">{{code}}</p>
<p>The code expires in 10 minutes. If you didn't request a reset, you can ignore this email.</p>`,
    });
  }
  // Same response whether or not the account exists — no account enumeration.
  return ok(res, null, "If that email belongs to an account, a reset code is on its way.");
});

export const resetPassword = asyncHandler(async (req, res) => {
  const userId = await resetPasswordService(req.body);
  recordAudit({
    userId,
    action: "Password reset via email code",
    entityType: "user",
    entityId: userId,
    ip: req.ip,
  });
  return ok(res, null, "Password updated. You can sign in with your new password.");
});

export const updateMyProfile = asyncHandler(async (req, res) => {
  const user = await updateProfile(req.user._id, req.body);
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

// ── Google sign-in (OAuth 2.0) ───────────────────────────────────────────────
// The browser is redirected to the backend, so the session token travels back
// to the SPA through the URL fragment of ${frontendUrl}/auth/callback — the
// frontend GoogleCallbackPage parses `#token=...&user=<base64url json>`.

const OAUTH_STATE_COOKIE = env.google.stateCookieName ?? "google_oauth_state";
const OAUTH_STATE_MAX_AGE_MS = 10 * 60 * 1000;

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

// Redirect target handed back to the SPA after a Google flow finishes
// (successfully or not). Keeping every outcome inside the hash means tokens
// and errors never reach server logs or referrer headers.
function googleResultRedirect({ token, user, error } = {}) {
  const params = new URLSearchParams();
  if (token) params.set("token", token);
  if (user) params.set("user", base64UrlJson(user));
  if (error) params.set("error", error);
  return `${env.frontendUrl}/auth/callback#${params.toString()}`;
}

// GET /auth/google — kicks off the consent redirect with a CSRF state cookie.
export const googleStart = asyncHandler(async (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  res.cookie(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: env.cookie.sameSite,
    secure: env.cookie.secure,
    maxAge: OAUTH_STATE_MAX_AGE_MS,
  });
  return res.redirect(googleAuthUrl(state));
});

// GET /auth/google/callback — verifies state, exchanges the code for a Google
// profile, links or provisions the local account, then redirects to the SPA
// with the session token. Every failure lands back on /auth/callback without a
// token so the frontend shows its standard retry message.
export const googleCallback = asyncHandler(async (req, res) => {
  const expectedState = req.cookies?.[OAUTH_STATE_COOKIE];
  res.clearCookie(OAUTH_STATE_COOKIE);

  if (!expectedState || !req.query.state || req.query.state !== expectedState) {
    return res.redirect(googleResultRedirect({ error: "google_state_mismatch" }));
  }

  let profile;
  try {
    profile = await exchangeCodeForProfile(String(req.query.code ?? ""));
  } catch {
    return res.redirect(googleResultRedirect({ error: "google_exchange_failed" }));
  }

  // Link by Google id first, then by verified email (case-insensitive).
  let user =
    (profile.googleId && (await User.findOne({ googleId: profile.googleId }))) ||
    (await User.findOne({ email: profile.email }).collation({
      locale: "en",
      strength: 2,
    }));

  if (user && user.status === "removed") {
    return res.redirect(googleResultRedirect({ error: "google_account_removed" }));
  }

  if (!user) {
    // Self-provisioning path — mirrors registerUser/demo provisioning: new
    // accounts start as Pharmacists and finish setup through onboarding.
    user = await User.create({
      name: profile.name,
      email: profile.email,
      role: "Pharmacist",
      orgName: "PharmaHub Pharmacy",
      provider: "google",
      googleId: profile.googleId,
      picture: profile.picture,
      active: true,
      status: "active",
    });
  } else if (!user.googleId || user.provider !== "google") {
    user.googleId = profile.googleId;
    user.provider = "google";
  }
  if (user.picture !== profile.picture) user.picture = profile.picture;
  await user.save();

  recordAudit({
    userId: user._id,
    userName: user.name,
    action: "User signed in with Google",
    entityType: "user",
    entityId: user._id,
    ip: req.ip,
  });

  const token = issueToken(user._id);
  const publicUser = await toAuthUser(user.toObject());
  publicUser.profileCompletion = computeProfileCompletion(user);
  return res.redirect(googleResultRedirect({ token, user: publicUser }));
});
