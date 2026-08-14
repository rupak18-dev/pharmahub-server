import { Router } from "express";

import { validate } from "../middlewares/validate.js";
import { auth } from "../middlewares/auth.js";
import { onboardingSchemas } from "../types/index.js";
import * as onboardingController from "../controllers/onboarding.controller.js";

const router = Router();

router.use(auth);

router.get("/", onboardingController.get);
router.put("/", validate(onboardingSchemas.upsert), onboardingController.save);

export default router;
