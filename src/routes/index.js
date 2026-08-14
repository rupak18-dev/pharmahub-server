import { Router } from "express";

import healthRoutes from "./health.routes.js";
import authRoutes from "./auth.routes.js";
import onboardingRoutes from "./onboarding.routes.js";
import userRoutes from "./user.routes.js";
import roleRoutes from "./role.routes.js";
import categoryRoutes from "./category.routes.js";
import manufacturerRoutes from "./manufacturer.routes.js";
import supplierRoutes from "./supplier.routes.js";
import medicineRoutes from "./medicine.routes.js";
import batchRoutes from "./batch.routes.js";
import inventoryRoutes from "./inventory.routes.js";
import purchaseRoutes from "./purchase.routes.js";
import saleRoutes from "./sale.routes.js";
import auditRoutes from "./audit.routes.js";
import notificationRoutes from "./notification.routes.js";
import reportRoutes from "./report.routes.js";
import dashboardRoutes from "./dashboard.routes.js";

const router = Router();

router.use("/", healthRoutes);
router.use("/auth", authRoutes);
router.use("/onboarding", onboardingRoutes);
router.use("/users", userRoutes);
router.use("/roles", roleRoutes);
router.use("/categories", categoryRoutes);
router.use("/manufacturers", manufacturerRoutes);
router.use("/suppliers", supplierRoutes);
router.use("/medicines", medicineRoutes);
router.use("/batches", batchRoutes);
router.use("/inventory", inventoryRoutes);
router.use("/purchases", purchaseRoutes);
router.use("/sales", saleRoutes);
router.use("/audit", auditRoutes);
router.use("/notifications", notificationRoutes);
router.use("/reports", reportRoutes);
router.use("/dashboard", dashboardRoutes);

export default router;
