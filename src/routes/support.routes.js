import { Router } from "express";
import { auth, optionalAuth } from "../middlewares/auth.js";
import * as supportController from "../controllers/support.controller.js";

const router = Router();

router.get("/settings", optionalAuth, supportController.getSupportSettings);
router.put("/settings", auth, supportController.updateSupportSettings);

export default router;
