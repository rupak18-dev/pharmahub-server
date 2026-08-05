import { Router } from "express";

import { validate } from "../middlewares/validate.js";
import { auth } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { manufacturerSchemas } from "../types/index.js";
import * as manufacturerController from "../controllers/manufacturer.controller.js";

const router = Router();

router.use(auth);

router.get("/", authorize("medicines", "view"), manufacturerController.listManufacturers);
router.get("/:id", authorize("medicines", "view"), manufacturerController.getManufacturer);
router.post("/", authorize("medicines", "create"), validate(manufacturerSchemas.create), manufacturerController.createManufacturer);
router.patch("/:id", authorize("medicines", "update"), validate(manufacturerSchemas.update), manufacturerController.updateManufacturer);
router.delete("/:id", authorize("medicines", "delete"), manufacturerController.deleteManufacturer);

export default router;
