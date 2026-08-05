import { Router } from "express";

import { auth } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import * as auditController from "../controllers/audit.controller.js";

const router = Router();

router.use(auth);

router.get("/", authorize("audit", "view"), auditController.listAuditLogs);
router.get("/:id", authorize("audit", "view"), auditController.getAuditLog);
router.post("/", authorize("audit", "create"), auditController.createAuditLog);

export default router;
