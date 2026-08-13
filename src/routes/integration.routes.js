import { Router } from "express";
import { auth } from "../middlewares/auth.js";
import * as integrationController from "../controllers/integration.controller.js";

const router = Router();

router.use(auth);

router.get("/", integrationController.listIntegrations);
router.post("/:key/connect", integrationController.connectIntegration);
router.post("/:key/disconnect", integrationController.disconnectIntegration);

export default router;
