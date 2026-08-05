import { Router } from "express";

import * as healthController from "../controllers/health.controller.js";

const router = Router();

router.get("/health", healthController.health);
router.get("/info", healthController.info);

export default router;
