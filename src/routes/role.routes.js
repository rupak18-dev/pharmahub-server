import { Router } from "express";

import { auth } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import * as roleController from "../controllers/role.controller.js";

const router = Router();

router.use(auth);

router.get("/", authorize("users", "view"), roleController.listRoles);
router.get("/:id", authorize("users", "view"), roleController.getRole);
router.post("/", authorize("users", "create"), roleController.createRole);
router.patch("/:id", authorize("users", "update"), roleController.updateRole);
router.delete("/:id", authorize("users", "delete"), roleController.deleteRole);

export default router;
