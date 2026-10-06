import { Router } from "express";
import rateLimit from "express-rate-limit";

import { validate } from "../middlewares/validate.js";
import { auth, authOptional } from "../middlewares/auth.js";
import { authSchemas } from "../types/index.js";
import * as authController from "../controllers/auth.controller.js";

const blockedMessage = { success: false, error: { message: "Too many requests, please try again later." } };

// Tight per-endpoint limits on credential/OTP flows — the global limiter in
// app.js is too coarse to stop login/OTP brute force on its own.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: blockedMessage,
});

const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: blockedMessage,
});

const sensitiveActionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: blockedMessage,
});

const router = Router();

router.post(
  "/register",
  loginLimiter,
  validate(authSchemas.register),
  authController.register,
);

router.post(
  "/login",
  loginLimiter,
  validate(authSchemas.login),
  authController.login,
);

router.post("/logout", authOptional, authController.logout);

router.get("/me", auth, authController.me);

router.put("/profile", auth, validate(authSchemas.profile), authController.updateMyProfile);
router.post(
  "/change-password",
  auth,
  sensitiveActionLimiter,
  validate(authSchemas.changePassword),
  authController.updatePassword,
);
router.post(
  "/forgot-password",
  otpLimiter,
  validate(authSchemas.forgotPassword),
  authController.forgotPassword,
);
router.post(
  "/reset-password",
  otpLimiter,
  validate(authSchemas.resetPassword),
  authController.resetPassword,
);
router.post(
  "/verify-email",
  otpLimiter,
  validate(authSchemas.verifyEmail),
  authController.verifyEmail,
);
router.post(
  "/resend-verification",
  otpLimiter,
  validate(authSchemas.resendVerification),
  authController.resendVerification,
);

// Google OAuth
router.get("/google", authController.googleStart);

router.get("/google/callback", authController.googleCallback);

export default router;