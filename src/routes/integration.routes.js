import { Router } from "express";
import { auth } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { validate } from "../middlewares/validate.js";
import { integrationSchemas } from "../types/index.js";
import * as integrationController from "../controllers/integration.controller.js";
import * as gmailController from "../controllers/gmail.controller.js";

const router = Router();

// Google redirects the browser straight here after OAuth consent — there is no
// PharmaHub bearer token in this request, so the callback is intentionally
// public. Tenant identity comes from the signed `state` value, never from
// anything the client controls.
router.get("/gmail/callback", gmailController.callback);

router.use(auth);

// Organization-level Gmail integration (send-only). Connect starts Google OAuth
// for the authenticated user's organization; test/disconnect act on that
// organization's connected account only.
router.get("/gmail/connect", authorize("integrations", "update"), gmailController.startConnect);
router.post("/gmail/test", authorize("integrations", "update"), gmailController.sendTest);
router.delete("/gmail", authorize("integrations", "update"), gmailController.disconnect);

router.get("/", authorize("integrations", "view"), integrationController.listIntegrations);
router.get("/:id", authorize("integrations", "view"), integrationController.getIntegration);
router.post(
  "/:id/connect",
  authorize("integrations", "update"),
  validate(integrationSchemas.connect),
  integrationController.connectIntegration,
);
router.put(
  "/:id/configure",
  authorize("integrations", "update"),
  validate(integrationSchemas.configure),
  integrationController.configureIntegration,
);
router.post(
  "/:id/disconnect",
  authorize("integrations", "update"),
  integrationController.disconnectIntegration,
);

export default router;
