import crypto from "node:crypto";

import { asyncHandler } from "../core/asyncHandler.js";
import { ok, created } from "../core/responses.js";
import { logger } from "../core/logger.js";
import { env } from "../config/env.js";
import { User } from "../models/User.js";
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
import { googleAuthUrl, exchangeCodeForProfile } from "../services/googleAuth.service.js";
import { createAndSendOtp } from "../services/otp.service.js";
import { recordAudit } from "../services/audit.service.js";

const STATE_COOKIE_MAX_AGE_MS = 10 * 60 * 1000;

// FRONTEND_URL is often configured with a trailing slash (or defaulted to one),
// which would turn `/auth/callback` into `//auth/callback` and 404 in the SPA.
function frontendUrlBase() {
  return String(env.google.frontendUrl ?? "").replace(/\/+$/, "");
}

function googleStateCookieOptions() {
  return {
    httpOnly: true,
    secure: env.cookie.secure,
    sameSite: env.cookie.sameSite,
    path: "/",
    maxAge: STATE_COOKIE_MAX_AGE_MS,
  };
}

function googleCallbackRedirect({ token, user }) {
  const userParam = encodeURIComponent(Buffer.from(JSON.stringify(user)).toString("base64url"));
  return `${frontendUrlBase()}/auth/callback#token=${encodeURIComponent(token)}&user=${userParam}`;
}

export const register = asyncHandler(async (req, res) => {
  const result = await registerUser(req.body);
  setSessionCookie(res, result.token);
  recordAudit({
    userId: result.user?.id,
    userName: result.user?.name,
    action: "User registered",
    entityType: "user",
    entityId: result.user?.id,
    ip: req.ip,
  });
  return created(res, result, "Registration successful. Welcome to PharmaHub!");
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
    userId: user.id,
    userName: user.name,
    action: "User profile updated",
    entityType: "user",
    entityId: user.id,
    ip: req.ip,
  });
  return ok(res, user, "Profile updated");
});

export const googleStart = asyncHandler(async (req, res) => {
  const state = crypto.randomBytes(24).toString("hex");
  res.cookie(env.google.stateCookieName, state, googleStateCookieOptions());
  return res.redirect(googleAuthUrl(state));
});

function googleFailRedirect(reason, err) {
  logger.error(`Google sign-in failed (${reason})`, err);
  const params = new URLSearchParams({ google: "error" });
  if (!env.isProduction && reason) params.set("reason", reason);
  return `${frontendUrlBase()}/login?${params.toString()}`;
}

export const googleCallback = asyncHandler(async (req, res) => {
  const { code, state, error } = req.query;

  res.clearCookie(env.google.stateCookieName, googleStateCookieOptions());
  if (error || !code) {
    return res.redirect(googleFailRedirect(error ? `google:${error}` : "missing_code"));
  }

  const expectedState = req.cookies?.[env.google.stateCookieName];
  if (!expectedState || !state || expectedState !== state) {
    logger.error("Google state cookie mismatch", {
      hasCookie: Boolean(expectedState),
      hasQueryState: Boolean(state),
      cookieValue: expectedState ?? null,
      queryValue: state ?? null,
    });
    return res.redirect(googleFailRedirect("state_mismatch"));
  }

  try {
    const profile = await exchangeCodeForProfile(code);

    const existing = await User.findOne({ email: profile.email }).collation({
      locale: "en",
      strength: 2,
    });
    if (existing) {
      const result = await signInWithGoogle(profile);
      setSessionCookie(res, result.token);
      recordAudit({
        userId: result.user.id,
        userName: result.user.name,
        action: "User signed in with Google",
        entityType: "user",
        entityId: result.user.id,
        ip: req.ip,
      });
      return res.redirect(googleCallbackRedirect(result));
    }

    // Brand-new Google email → create the account directly; Google has already
    // verified ownership of the email.
    const result = await signUpWithGoogle(profile);
    setSessionCookie(res, result.token);
    recordAudit({
      userId: result.user.id,
      userName: result.user.name,
      action: "User signed up with Google",
      entityType: "user",
      entityId: result.user.id,
      ip: req.ip,
    });
    return res.redirect(googleCallbackRedirect(result));
  } catch (err) {
    return res.redirect(googleFailRedirect("token_exchange", err));
  }
});
