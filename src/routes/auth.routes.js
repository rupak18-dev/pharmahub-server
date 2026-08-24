import { Router } from "express";

import { validate } from "../middlewares/validate.js";
import { auth } from "../middlewares/auth.js";
import { authSchemas, userSchemas } from "../types/index.js";
import * as authController from "../controllers/auth.controller.js";

const router = Router();

router.post(
  "/register",
  validate(authSchemas.register),
  authController.register,
);

router.post(
  "/login",
  validate(authSchemas.login),
  authController.login,
);

router.post(
  "/demo-login",
  validate(authSchemas.demoLogin),
  authController.demoLogin,
);

router.post(
  "/demo-login/verify",
  validate(authSchemas.demoLoginVerify),
  authController.demoLoginVerify,
);

router.get("/me", auth, authController.me);

router.post("/logout", auth, authController.logout);

router.post(
  "/change-password",
  auth,
  validate(authSchemas.changePassword),
  authController.updatePassword,
);

// PUT /auth/profile — convenience alias used by the frontend auth service.
// Validated with the same schema as PUT /users/me/profile; unknown fields
// (role, permissions, ...) are stripped before they reach the controller.
router.put(
  "/profile",
  auth,
  validate(userSchemas.updateProfile),
  authController.updateMyProfile,
);

// Google OAuth
router.get("/google", authController.googleStart);

router.get("/google/callback", authController.googleCallback);

export default router;