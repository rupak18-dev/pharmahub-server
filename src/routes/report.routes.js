import { Router } from "express";

import { auth } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import * as reportController from "../controllers/report.controller.js";

const router = Router();

router.use(auth);

router.get("/sales", authorize("reports", "view"), reportController.getSalesReport);
router.get("/purchases", authorize("reports", "view"), reportController.getPurchaseReport);
router.get("/expiry", authorize("reports", "view"), reportController.getExpiryReport);
router.get("/stock-valuation", authorize("reports", "view"), reportController.getStockValuation);

export default router;
