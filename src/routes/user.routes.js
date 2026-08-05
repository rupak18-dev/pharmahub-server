import { Router } from "express";

import { validate } from "../middlewares/validate.js";
import { auth } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { userSchemas } from "../types/index.js";
import * as userController from "../controllers/user.controller.js";

const router = Router();

router.use(auth);

router.get("/", authorize("users", "view"), userController.listUsers);
router.post("/", authorize("users", "create"), validate(userSchemas.create), userController.createUser);
router.get("/:id", authorize("users", "view"), userController.getUser);
router.patch("/:id", authorize("users", "update"), validate(userSchemas.update), userController.updateUser);
router.delete("/:id", authorize("users", "delete"), userController.deleteUser);

export default router;
