import { Router } from "express";

import { validate } from "../middlewares/validate.js";
import { auth } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { inventorySchemas } from "../types/index.js";
import * as inventoryController from "../controllers/inventory.controller.js";

const router = Router();

router.use(auth);

router.get("/", authorize("inventory", "view"), inventoryController.listInventory);
router.get("/ledger", authorize("inventory", "view"), inventoryController.listLedger);
router.get("/movements", authorize("inventory", "view"), inventoryController.listStockMovements);
router.get(
  "/medicines/:medicineId",
  authorize("inventory", "view"),
  inventoryController.getStockByMedicine,
);
router.post(
  "/add",
  authorize("inventory", "create"),
  validate(inventorySchemas.addStock),
  inventoryController.addStockToBatch,
);
router.post(
  "/adjust",
  authorize("inventory", "update"),
  validate(inventorySchemas.adjustStock),
  inventoryController.adjustStockLevel,
);
router.post(
  "/movements",
  authorize("inventory", "update"),
  validate(inventorySchemas.movement),
  inventoryController.recordMovement,
);

export default router;
