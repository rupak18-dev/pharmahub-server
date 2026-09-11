import crypto from "node:crypto";

import { asyncHandler } from "../core/asyncHandler.js";
import { ok, created } from "../core/responses.js";
import { logger } from "../core/logger.js";
import { ApiError } from "../core/ApiError.js";
import { env } from "../config/env.js";
import {
  loginUser,
  registerUser,
  changePassword,
  toAuthUser,
  setSessionCookie,
  clearSessionCookie,
  issueToken,
  resetPassword as resetPasswordService,
} from "../services/auth.service.js";
import {
  googleAuthUrl,
  exchangeCodeForProfile,
} from "../services/googleAuth.service.js";
import { createAndSendOtp, verifyOtp } from "../services/otp.service.js";
import { buildVerificationEmail } from "../services/emailTemplates.js";
import { recordAudit } from "../services/audit.service.js";
import { computeProfileCompletion } from "../services/profileCompletion.service.js";
import { User } from "../models/User.js";

export const register = asyncHandler(async (req, res) => {
  const result = await registerUser(req.body);
  setSessionCookie(res, result.token, { remember: true });
  recordAudit({
    userId: result.user?.id,
    userName: result.user?.name,
    action: "User registered",
    entityType: "user",
    entityId: result.user?.id,
    ip: req.ip,
  });

  // Email an unverified-code check before the account can be used. The
  // {{otp_code}} placeholder is replaced by otp.service once the code is minted.
  const verification = buildVerificationEmail({
    name: result.user?.name,
    code: "{{otp_code}}",
    expiresInMinutes: 10,
    verifyUrl: `${env.frontendUrl}/verify-email`,
  });
  await createAndSendOtp({
    email: result.user.email,
    purpose: "email_verify",
    subject: verification.subject,
    html: verification.html,
  });

  // No session cookie is issued: the new account is unverified and must prove
  // the inbox before first sign-in (see loginUser gate). The OTP ships only in
  // the email — it is never echoed back to the client.
  return created(
    res,
    { user: result.user },
    "Registration successful. Check your email for the verification code.",
  );
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
  // Session JWT travels as an httpOnly cookie — never in the response body.
  return ok(res, { user: result.user }, "Login successful");
});


// GET /auth/me — returns the current user with full effective permissions and
// profile completion score. Delegates to the same enrichment logic used by
// GET /users/me so the frontend always gets a consistent user shape.
export const me = asyncHandler(async (req, res) => {
  // Identity must never be served from any HTTP cache — a cached response
  // could return the PREVIOUS user after a logout + different login.
  res.set("Cache-Control", "no-store");
  const user = await User.findById(req.user._id).lean();
  if (!user) {
    // Middleware already verified the user exists; this is a safety fallback.
    logger.warn(`[auth.me] token userId=${req.user._id} not found in database`);
    const publicUser = await toAuthUser(req.user);
    publicUser.profileCompletion = computeProfileCompletion(req.user);
    return ok(res, publicUser, "Current user");
  }
  logger.info(
    `[auth.me] session userId=${user._id} email=${user.email} role=${user.role}`,
  );
  const publicUser = await toAuthUser(user);
  publicUser.profileCompletion = computeProfileCompletion(user);
  return ok(res, publicUser, "Current user");
});

export const logout = asyncHandler(async (req, res) => {
  clearSessionCookie(res);
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

// POST /auth/verify-email — public (pre-login). Consumes the emailed code and
// flips the account to verified. Reusing the OTP service keeps brute-force
// protection (5 attempts, 10-min expiry, one-time consumption).
export const verifyEmail = asyncHandler(async (req, res) => {
  const email = req.body.email.toLowerCase();
  await verifyOtp({ email, purpose: "email_verify", code: req.body.code });

  const user = await User.findOne({ email }).collation({ locale: "en", strength: 2 });
  if (!user) throw ApiError.badRequest("No account found for this email");

  let justVerified = false;
  if (user.emailVerified !== true) {
    user.emailVerified = true;
    user.emailVerifiedAt = new Date();
    user.active = true;
    await user.save();
    justVerified = true;
    recordAudit({
      userId: user._id,
      userName: user.name,
      action: "Email address verified",
      entityType: "user",
      entityId: user._id,
      ip: req.ip,
    });
  }
  return ok(
    res,
    { emailVerified: true, emailVerifiedAt: user.emailVerifiedAt, justVerified },
    justVerified ? "Email verified. You can now sign in." : "This email is already verified.",
  );
});

// POST /auth/resend-verification — public (pre-login). Always answers with the
// same message whether or not an account exists, so the endpoint cannot be used
// to enumerate which emails are registered.
export const resendVerification = asyncHandler(async (req, res) => {
  const email = req.body.email.toLowerCase();
  const user = await User.findOne({ email })
    .collation({ locale: "en", strength: 2 })
    .select("_id name active emailVerified")
    .lean();

  if (user?.active && user.emailVerified === false) {
    const verification = buildVerificationEmail({
      name: user.name,
      code: "{{otp_code}}",
      expiresInMinutes: 10,
      verifyUrl: `${env.frontendUrl}/verify-email`,
    });
    await createAndSendOtp({
      email,
      purpose: "email_verify",
      subject: verification.subject,
      html: verification.html,
    });
  }
  return ok(res, null, "If that email needs verification, a new code is on its way.");
});

// PUT /auth/profile — convenience alias for PUT /users/me/profile so the
// frontend auth service does not need to know about the /users prefix.
export { updateMyProfile } from "./user.controller.js";

// ── Google sign-in (OAuth 2.0) ───────────────────────────────────────────────
// The browser is redirected to the backend, which sets the session as an
// httpOnly cookie before bouncing back to the SPA — no token in any URL.
const OAUTH_STATE_COOKIE = env.google.stateCookieName ?? "google_oauth_state";
const OAUTH_STATE_MAX_AGE_MS = 10 * 60 * 1000;

// Redirect target handed back to the SPA after a Google flow finishes
// (successfully or not). The session itself is set as an httpOnly cookie by
// the callback before redirecting, so no token ever appears in the URL.
function googleResultRedirect({ error } = {}) {
  const suffix = error ? `?error=${encodeURIComponent(error)}` : "";
  return `${env.frontendUrl}/auth/callback${suffix}`;
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
    // Self-provisioning path — new Google accounts stay role-less (neutral)
    // until the Owner explicitly assigns a role. Never a silent default.
    user = await User.create({
      name: profile.name,
      email: profile.email,
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
  // Session travels as an httpOnly cookie; the SPA hydrates via GET /auth/me.
  setSessionCookie(res, token);
  return res.redirect(googleResultRedirect({}));
});
