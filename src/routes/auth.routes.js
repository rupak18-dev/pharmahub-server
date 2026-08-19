import { Router } from "express";

import { validate } from "../middlewares/validate.js";
import { auth } from "../middlewares/auth.js";
import { authSchemas } from "../types/index.js";
import * as authController from "../controllers/auth.controller.js";

const router = Router();

router.post("/register", validate(authSchemas.register), authController.register);
router.post("/login", validate(authSchemas.login), authController.login);
router.get("/me", auth, authController.me);
router.post("/change-password", auth, validate(authSchemas.changePassword), authController.updatePassword);
router.put("/profile", auth, authController.updateProfile);
router.get("/google", authController.googleLogin);

export default router;
