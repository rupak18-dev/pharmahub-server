import { Router } from "express";

import { validate } from "../middlewares/validate.js";
import { auth } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { medicineSchemas } from "../types/index.js";
import * as medicineController from "../controllers/medicine.controller.js";

const router = Router();

router.use(auth);

router.get("/", authorize("medicines", "view"), medicineController.listMedicines);
router.get("/:id", authorize("medicines", "view"), medicineController.getMedicine);
router.post(
  "/",
  authorize("medicines", "create"),
  validate(medicineSchemas.create),
  medicineController.createMedicine,
);
router.patch(
  "/:id",
  authorize("medicines", "update"),
  validate(medicineSchemas.update),
  medicineController.updateMedicine,
);
router.delete("/:id", authorize("medicines", "delete"), medicineController.deleteMedicine);

export default router;
