import { Router } from "express";

import { validate } from "../middlewares/validate.js";
import { auth } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { categorySchemas } from "../types/index.js";
import * as categoryController from "../controllers/category.controller.js";

const router = Router();

router.use(auth);

router.get("/", authorize("medicines", "view"), categoryController.listCategories);
router.get("/:id", authorize("medicines", "view"), categoryController.getCategory);
router.post("/", authorize("medicines", "create"), validate(categorySchemas.create), categoryController.createCategory);
router.patch("/:id", authorize("medicines", "update"), validate(categorySchemas.update), categoryController.updateCategory);
router.delete("/:id", authorize("medicines", "delete"), categoryController.deleteCategory);

export default router;
