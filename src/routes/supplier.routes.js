import { Router } from "express";

import { validate } from "../middlewares/validate.js";
import { auth } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { supplierSchemas } from "../types/index.js";
import * as supplierController from "../controllers/supplier.controller.js";

const router = Router();

router.use(auth);

router.get("/", authorize("purchases", "view"), supplierController.listSuppliers);
router.get("/:id", authorize("purchases", "view"), supplierController.getSupplier);
router.post("/", authorize("purchases", "create"), validate(supplierSchemas.create), supplierController.createSupplier);
router.patch("/:id", authorize("purchases", "update"), validate(supplierSchemas.update), supplierController.updateSupplier);
router.delete("/:id", authorize("purchases", "delete"), supplierController.deleteSupplier);

export default router;
