import { Router } from "express";

import { validate } from "../middlewares/validate.js";
import { auth } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { purchaseSchemas } from "../types/index.js";
import * as purchaseController from "../controllers/purchase.controller.js";

const router = Router();

router.use(auth);

router.get("/", authorize("purchases", "view"), purchaseController.listPurchases);
router.get("/:id", authorize("purchases", "view"), purchaseController.getPurchase);
router.post(
  "/",
  authorize("purchases", "create"),
  validate(purchaseSchemas.create),
  purchaseController.createPurchase,
);
router.post(
  "/:id/receive",
  authorize("purchases", "update"),
  validate(purchaseSchemas.receive),
  purchaseController.receive,
);
router.patch(
  "/:id/status",
  authorize("purchases", "update"),
  validate(purchaseSchemas.updateStatus),
  purchaseController.updateStatus,
);
router.delete("/:id", authorize("purchases", "delete"), purchaseController.deletePurchase);

export default router;
