import { Router } from "express";

import { validate } from "../middlewares/validate.js";
import { auth } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { notificationSchemas } from "../types/index.js";
import * as notificationController from "../controllers/notification.controller.js";

const router = Router();

router.use(auth);

router.get("/", authorize("notifications", "view"), notificationController.listNotifications);
router.get("/unread-count", authorize("notifications", "view"), notificationController.unreadCount);
router.get("/:id", authorize("notifications", "view"), notificationController.getNotification);
router.post("/", authorize("notifications", "create"), notificationController.createNotification);
router.patch("/read", authorize("notifications", "update"), validate(notificationSchemas.markRead), notificationController.markRead);

export default router;
