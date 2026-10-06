import { Router } from "express";
import { auth } from "../middlewares/auth.js";
import { get, save } from "../controllers/onboarding.controller.js";

// All onboarding persistence flows through the controller so completion-time
// side effects (role adoption, onboarded flag) always run.
const router = Router();

router.get("/", auth, get);
router.put("/", auth, save);

export default router;
