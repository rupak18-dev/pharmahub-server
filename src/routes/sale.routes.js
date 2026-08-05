import { Router } from "express";

import { validate } from "../middlewares/validate.js";
import { auth } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { saleSchemas } from "../types/index.js";
import * as saleController from "../controllers/sale.controller.js";

const router = Router();

router.use(auth);

router.get("/", authorize("sales", "view"), saleController.listSales);
router.get("/:id", authorize("sales", "view"), saleController.getSale);
router.post("/", authorize("sales", "create"), validate(saleSchemas.create), saleController.create);
router.post("/:id/void", authorize("sales", "update"), validate(saleSchemas.void), saleController.voidSaleById);

export default router;
