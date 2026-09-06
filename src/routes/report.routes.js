import { Router } from "express";
import { auth } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { runUpload, uploadBillImage } from "../middlewares/upload.js";
import * as reportController from "../controllers/report.controller.js";
import * as reportDataController from "../controllers/reportData.controller.js";

const router = Router();

router.use(auth);

router.get("/", authorize("reports", "view"), reportController.getReportCatalog);
router.get("/sales", authorize("reports", "view"), reportController.getSalesReport);

router.get("/purchases", authorize("reports", "view"), reportController.getPurchaseReport);
router.get("/expiry", authorize("reports", "view"), reportController.getExpiryReport);
router.get("/stock-valuation", authorize("reports", "view"), reportController.getStockValuation);

router.post("/custom", authorize("reports", "view"), reportController.generateCustomReport);

/* Report Data — Sales & Bills management (owner-scoped) */
router.get("/data", authorize("reports", "view"), reportDataController.getDataSources);
router.get("/data/sales", authorize("reports", "view"), reportDataController.listSalesBills);
// Static routes must be declared before the /data/sales/:id parameterized route.
router.post(
  "/data/sales/upload",
  authorize("reports", "create"),
  runUpload(uploadBillImage),
  reportDataController.uploadSalesBill,
);
router.post(
  "/data/sales/validate-import",
  authorize("reports", "create"),
  reportDataController.validateSalesImport,
);
router.post(
  "/data/sales/import",
  authorize("reports", "create"),
  reportDataController.importSalesBills,
);
router.get("/data/sales/:id", authorize("reports", "view"), reportDataController.getSalesBill);
router.post("/data/sales", authorize("reports", "create"), reportDataController.createSalesBill);
router.put("/data/sales/:id", authorize("reports", "update"), reportDataController.updateSalesBill);
router.delete(
  "/data/sales/:id",
  authorize("reports", "delete"),
  reportDataController.deleteSalesBill,
);

/* Report Data — Purchases management (owner-scoped, mirrors sales) */
router.get("/data/purchases", authorize("reports", "view"), reportDataController.listPurchases);
router.post(
  "/data/purchases/upload",
  authorize("reports", "create"),
  runUpload(uploadBillImage),
  reportDataController.uploadPurchaseDocument,
);
router.post(
  "/data/purchases/validate-import",
  authorize("reports", "create"),
  reportDataController.validatePurchaseImport,
);
router.post(
  "/data/purchases/import",
  authorize("reports", "create"),
  reportDataController.importPurchases,
);
router.get("/data/purchases/:id", authorize("reports", "view"), reportDataController.getPurchase);
router.post("/data/purchases", authorize("reports", "create"), reportDataController.createPurchase);
router.put(
  "/data/purchases/:id",
  authorize("reports", "update"),
  reportDataController.updatePurchase,
);
router.delete(
  "/data/purchases/:id",
  authorize("reports", "delete"),
  reportDataController.deletePurchase,
);
// Read-only listing for the other report data sources.
// The unified bills manager routes must stay ABOVE /data/:source.
router.get(
  "/data/bills/summary",
  authorize("reports", "view"),
  reportDataController.getReportBillsSummary,
);
router.get("/data/bills", authorize("reports", "view"), reportDataController.listReportBills);
router.get("/data/bills/:id", authorize("reports", "view"), reportDataController.getReportBill);
router.post("/data/bills", authorize("reports", "create"), reportDataController.createReportBill);
router.post(
  "/data/bills/:id/whatsapp",
  authorize("reports", "create"),
  reportDataController.sendReportBillWhatsApp,
);
router.post(
  "/data/bills/:id/whatsapp/retry",
  authorize("reports", "create"),
  reportDataController.retryReportBillWhatsApp,
);
router.put(
  "/data/bills/:id",
  authorize("reports", "update"),
  reportDataController.updateReportBill,
);
router.delete(
  "/data/bills/:id",
  authorize("reports", "delete"),
  reportDataController.deleteReportBill,
);
router.get("/data/:source", authorize("reports", "view"), reportDataController.getSourceData);

router.get("/saved", authorize("reports", "view"), reportController.getSavedReports);
router.post("/saved", authorize("reports", "create"), reportController.createSavedReport);
router.put("/saved/:id", authorize("reports", "update"), reportController.updateSavedReport);
router.delete("/saved/:id", authorize("reports", "delete"), reportController.deleteSavedReport);

router.get("/schedules", authorize("reports", "view"), reportController.getScheduledReports);
router.post("/schedules", authorize("reports", "create"), reportController.createScheduledReport);
router.put(
  "/schedules/:id",
  authorize("reports", "update"),
  reportController.updateScheduledReport,
);
router.delete(
  "/schedules/:id",
  authorize("reports", "delete"),
  reportController.deleteScheduledReport,
);

export default router;
