import { Router } from "express";

import { validate } from "../middlewares/validate.js";
import { auth } from "../middlewares/auth.js";
import { authSchemas } from "../types/index.js";
import * as authController from "../controllers/auth.controller.js";

const router = Router();

router.post("/register", validate(authSchemas.register), authController.register);
router.post("/login", validate(authSchemas.login), authController.login);
router.post("/logout", authController.logout);
router.get("/me", auth, authController.me);
router.put("/profile", auth, validate(authSchemas.profile), authController.updateMyProfile);
router.post("/change-password", auth, validate(authSchemas.changePassword), authController.updatePassword);
router.post(
  "/forgot-password",
  validate(authSchemas.forgotPassword),
  authController.forgotPassword,
);
router.post(
  "/reset-password",
  validate(authSchemas.resetPassword),
  authController.resetPassword,
);

router.get("/google", authController.googleStart);
router.get("/google/callback", authController.googleCallback);

export default router;
