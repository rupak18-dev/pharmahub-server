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

router.post("/custom", authorize("reports", "view"), reportController.generateCustomReport);

router.get("/saved", authorize("reports", "view"), reportController.getSavedReports);
router.post("/saved", authorize("reports", "create"), reportController.createSavedReport);
router.put("/saved/:id", authorize("reports", "update"), reportController.updateSavedReport);
router.delete("/saved/:id", authorize("reports", "delete"), reportController.deleteSavedReport);

router.get("/schedules", authorize("reports", "view"), reportController.getScheduledReports);
router.post("/schedules", authorize("reports", "create"), reportController.createScheduledReport);
router.put("/schedules/:id", authorize("reports", "update"), reportController.updateScheduledReport);
router.delete("/schedules/:id", authorize("reports", "delete"), reportController.deleteScheduledReport);

export default router;
