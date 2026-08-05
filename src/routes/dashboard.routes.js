import { Router } from "express";

import { auth } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import * as dashboardController from "../controllers/dashboard.controller.js";

const router = Router();

router.use(auth);

router.get("/stats", authorize("dashboard", "view"), dashboardController.getStats);
router.get("/notifications", authorize("dashboard", "view"), dashboardController.getNotifications);

export default router;
