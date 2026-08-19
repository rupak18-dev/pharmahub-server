import { Router } from "express";
import { auth } from "../middlewares/auth.js";
import { ok } from "../core/responses.js";

const router = Router();

router.get("/", auth, (req, res) => {
  return ok(res, {}, "Onboarding data");
});

router.put("/", auth, (req, res) => {
  return ok(res, req.body, "Onboarding data saved");
});

export default router;
